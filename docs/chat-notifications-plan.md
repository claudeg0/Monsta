# Unified chat notifications in Monsta — implementation plan

_Plan prompt: `docs/chat-notifications-plan-prompt.md`. Design memo: the prompt references `/opt/Monsta/docs/monsta-chat-notifications-memo.md`, which doesn't exist on disk — the memo is at `/etc/monsta-chat-notifications-memo.md` (identical content; it maps the codebase and this plan follows its technical direction). Scope: chat DMs/mentions surfacing in the existing global notifications panel. No implementation code in this document._

## 1. Summary & decisions

- **Goal**: chat DMs/mentions appear in the existing global notifications panel (hamburger menu) — one notification per channel, aggregated across messages, suppressed when the user's read cursor already covers the latest message in that channel.
- **Reuse, don't rebuild.** The existing pipeline is a straight fit: queue event → `NotificationsProcessor` → task → `Notification` row → `@AfterCreate` hook → `notifications.create` websocket event → per-user room (`WebsocketsProcessor.ts:807-816`) → client `NotificationsStore` → `NotificationsPopover`. Chat plugs in as one new event type + one new task. `ReactionCreatedNotificationsTask.ts:58-71` already proves the aggregate-reuse pattern this plan follows.
- **No revival bumping comes free.** `NotificationsStore.orderedData` (`app/stores/NotificationsStore.ts:65-69`) sorts by `createdAt` desc, unread first. The aggregate row's `createdAt` is never touched (model has `updatedAt: false`), so a revived row keeps its original panel position — product rule 1's "do not re-sort" holds by construction, no client sort hacks.
- **Suppression replaces presence.** Per rule 2 there is deliberately no "user is viewing" plumbing: `ChannelMembership.lastReadAt` (set by `channels.markRead`, `server/routes/api/channels/channels.ts:255`) is the only signal, checked at task-execution time.
- **Email exclusion is structural.** `EmailsProcessor` (`server/queues/processors/EmailsProcessor.ts:28-36`) subscribes to `notifications.create` and switches on `notification.event`; any event type without a `case` sends nothing. Rule 3 is satisfied by never adding a case for the chat event — made explicit and test-guarded rather than accidental.

### Product rules (non-negotiable, from the user)

1. ONE notification row per (user, channel). New messages update the existing unread row: increment a `messageCount` in the `data` JSONB, update the snippet/actor info, but DO NOT re-sort it to the top of the notifications list (no revival bumping).
2. SUPPRESS when the user read cursor for that channel is current (`lastReadAt >= newest message createdAt` at task-execution time). This replaces "user is viewing" presence — no new presence plumbing. The guard runs on **both the create and the update paths**.
3. NO email for chat notifications. Explicitly exclude `NotificationChannelType.Email` for the new event type.
4. Deep-link: clicking the notification in the global panel opens the chat channel.

## 2. Data model & migration

`yarn sequelize migration:create --name=add-channel-to-notifications` (dev DB; prod at deploy time per `CLAUDE.local.md`):

| change | detail |
|---|---|
| `channelId` | `DataTypes.UUID`, nullable, FK → `channels(id)` — null for every existing notification type; only chat rows set it. `documentId`/`commentId` stay null on chat rows (this is what risk 1 is about). |
| composite index | `(userId, channelId, viewedAt)` — serves the aggregation lookup exactly: `event = 'channels.message' AND userId = ? AND channelId = ? AND viewedAt IS NULL` |
| partial unique index | `(userId, channelId) WHERE event = 'channels.message' AND viewedAt IS NULL` — enforces rule 1's one-live-row at the DB level (belt-and-braces under the task's findOne; see open question in §7 about viewed-row history) |

`server/models/Notification.ts`: add the `channelId` column + `@BelongsTo(() => Channel, "channelId")` association. **Do not** add `channel` to the model's default scope (`server/models/Notification.ts:79-98` eagerly loads document/comment/actor/accessRequest for every query); the presenter should include it explicitly for chat rows, or `notifications.list` pays an extra join per row for all users (risk 1 / §7).

## 3. Server changes (file-by-file)

1. **`shared/types.ts`** — `NotificationEventType.CreateChatMessages = "channels.message"` (the prompt's suggested name; plural reads naturally for an aggregate). Distinct from the queue event `messages.create` (that name stays the websocket fan-out's) — the `event` column and `NotificationsProcessor` dispatch never collide. Add to `NotificationEventDefaults`: `true` (app on). Rule 3's email exclusion is enforced in EmailsProcessor (item 5 below), not here — the defaults map is a single boolean per event and can't express per-channel settings.
2. **Migration + model** — §2.
3. **`server/presenters/notification.ts`** — add `channelId: notification.channelId`; when set, include the channel (name/type only — enough for the client row). Mirroring the existing conditional `comment`/`document` includes keeps non-chat rows untouched.
4. **`server/queues/processors/NotificationsProcessor.ts`** — add `"messages.create"` to `applicableEvents` (`:29-42`) and a `messageCreated` case scheduling the new task. (`messages.create` is already emitted by `Message.createWithCtx` — no route changes.)
5. **New `server/queues/tasks/MessageCreatedNotificationsTask.ts`** (priority `Background`, structure mirroring `CommentCreatedNotificationsTask`). Pseudocode:
   ```
   perform(event):                                    # queue event messages.create
     message ← Message.findByPk(event.modelId, include createdBy)
     channel ← Channel.scope("withMemberships").findByPk(message.channelId)
     if !message or !channel: return

     snippet ← textBetween(prosemirrorDoc(message.data), 0, size),
               whitespace-collapsed, truncated ~140 chars
               # textBetween's leafText handling (ProsemirrorHelper) keeps
               # @mentions visible in the snippet

     for membership in channel.memberships:
       if membership.userId == message.createdById: continue
       recipient ← membership.user (batched fetch, not N per member)
       if !recipient.subscribedToEventType(CreateChatMessages): continue

       # RULE 2 — suppression, BEFORE any write, covering BOTH paths:
       # the cursor check gates create (no row at all) and update (an
       # aggregated row must not be revived for someone now caught up).
       if membership.lastReadAt and membership.lastReadAt >= message.createdAt:
         continue

       existing ← Notification.findOne({
         event: CreateChatMessages, userId, channelId,
         viewedAt: null, archivedAt: null,                  # only live rows aggregate
       })
       if existing:
         # RULE 1 — aggregate in place; createdAt deliberately NOT touched
         # (no revival bump), viewedAt stays null (findOne filtered on it).
         # Unlike the reaction task, no viewedAt/archivedAt reset — the row
         # is already live, so nothing needs reviving.
         existing.update({
           actorId: message.createdById,
           data: { messageCount: (existing.data.messageCount ?? 1) + 1, snippet },
         })
       else:
         # fresh row (rule 1); if a VIEWED chat row exists it doesn't match
         # the findOne, so history stays history — no resurrection
         Notification.create({
           event: CreateChatMessages, userId, actorId: message.createdById,
           teamId: channel.teamId, channelId: channel.id,
           data: { messageCount: 1, snippet },
         })
   ```
   Each `Notification.create` triggers the existing `@AfterCreate` → `notifications.create` → websocket pipeline unchanged. The aggregate path's `existing.update()` does **not** schedule a `notifications.update` event via hooks (Notification only has the AfterCreate hook) — see §7 open question on whether the panel needs live count refreshes for open panels.
6. **`server/queues/processors/EmailsProcessor.ts`** — **no new `case` for `CreateChatMessages`.** The switch (`:38+`) only emails known event types; unknown types fall through silently. This is rule 3's enforcement point; a comment in the switch stating "chat notifications are app-only by product decision" plus the §5 no-email test make the exclusion explicit rather than accidental. No `ChatCreatedEmail` template is created.
7. **No changes** to `WebsocketsProcessor` (the `notifications.create`/`update` cases at `:807-816` already present the payload to `user-<id>` and just grow `channelId`), `server/types.ts` (`MessageEvent` already exists), or `server/services/websockets.ts`.

## 4. Client changes (file-by-file)

1. **`app/models/Notification.ts`**
   - Add `channelId: string | null` field (presenter now sends it).
   - `path` getter (`:252`) — `case CreateChatMessages: return this.channelId ? chatPath(this.channelId) : ""` (rule 4; `chatPath` already exists at `app/utils/routeHelpers.ts:43`).
   - `eventText(t)` (`:189`) — `case CreateChatMessages:` count-aware plural, e.g. `t("sent {{count}} message in", ...)` / `t("sent {{count}} messages in", ...)` driven by `this.data.messageCount`.
   - `subject` getter (`:235`) — `case CreateChatMessages:` channel display name. `channel.name` is null for DMs (the client derives a DM name from the other participant — same rule `ChannelList` already uses); resolve via `rootStore.channels.get(channelId)` + member lookup, fallback `t("a conversation")` when the channel isn't loaded client-side.
2. **`app/components/Notifications/NotificationListItem.tsx`** — chat-specific row rendering (per technical direction: channel name + message count): when `event === CreateChatMessages`, render the snippet from `notification.data.snippet` as a tertiary, `truncateMultiline(3)` line (same treatment comment rows get at `:115-120`). The existing skeleton (avatar, actor, eventText, subject, time, UnreadBadge) already works with `document` simply absent — but **verify during build** that nothing in the row dereferences `notification.document` unguarded for chat rows (risk 1's render side; the current code guards via `?.` and optional chaining on `collectionId`).
3. **`app/stores/NotificationsStore.ts`** — no logic change: `orderedData` re-derives from the untouched `createdAt` (rule 1), and `notifications.create` upserts by id (`WebsocketProvider.tsx:939-941`). Verify during build that an upserted revival doesn't visually jump (it can't — sort key unchanged).
4. **`app/scenes/Chat/components/Thread.tsx`** — keep the read cursor current while viewing: on `messages.create` for the open channel, `void channels.markRead(channelId)`. Today markRead fires only on select-if-unread (`ChannelList.tsx:160-166`); without this, a user sitting in a channel would still accumulate notifications for messages they're reading (rule 2's suppression only works if the cursor moves). This is the sole feed of the suppression signal — no presence machinery.
5. **No new websocket handlers, no `NotificationIcon` change** — the bell badge (`approximateUnreadCount`) counts unviewed rows generically; chat rows join it automatically.

## 5. Testing plan

- **`MessageCreatedNotificationsTask.test.ts`** (colocated, mocked like existing task tests):
  - **Aggregation (rule 1)**: no existing row → one row with `data.messageCount === 1`, snippet stored, `channelId` set, author excluded, non-members excluded. Then a second message → same row, `messageCount === 2`, actor/snippet replaced, **`createdAt` byte-identical** (risk 2), `viewedAt` still null, exactly one row in the table.
  - **Suppression on the create path (rule 2)**: `membership.lastReadAt >= message.createdAt` → zero rows.
  - **Suppression on the update path (rule 2)**: live aggregate row exists; recipient's cursor now current → task runs, row **not** updated (count and `actorId` unchanged).
  - **Race test (risk 4, from the prompt)**: message created → user reads immediately (`channels.markRead` executes) → task runs → assert no notification created.
  - **No email (rule 3 / risk 5)**: notification created for the chat event → `EmailsProcessor.perform` resolves without scheduling any email (assert no email task enqueued); `emailedAt` stays null.
  - **Viewed-row non-resurrection**: an existing *viewed* chat row → a new row is created; the old one untouched.
  - Unsubscribe path: `subscribedToEventType` false → skipped.
- **`notifications.list` integration test (risk 1, from the prompt)** — seed a channel-only notification (`documentId`/`commentId` null, `channelId` set), call `notifications.list`, assert it renders: row present in results, presented payload has `channelId`, null document/comment, and no eager-load errors. Also run the existing notifications list tests to catch default-scope regressions.
- **Client model tests** — `path` returns `/chat/<channelId>`; `eventText` pluralization on `messageCount`; `subject` channel-name resolution including the DM-name derivation and unloaded-channel fallback.
- **Websocket round-trip** — `notifications.create` for a chat row emits the presented payload (with `channelId`) to `user-<id>` (extend the existing WebsocketsProcessor notification tests).
- **Manual click-through (dev, two users)** — DM + group; aggregation count grows; suppression while viewing (no notification at all); deep-link lands in the right channel; revival doesn't move the row; bell badge counts chat rows.

## 6. Build order

1. **Schema segment** — migration (column + both indexes), `Notification` model association, presenter `channelId`, test factories. *Commit checkpoint.*
2. **Pipeline segment** — event type + defaults entry, processor subscription, `MessageCreatedNotificationsTask` + full unit coverage (§5 task tests, including race and no-email). *Commit checkpoint.*
3. **Client segment** — `Notification` model (`channelId`/`path`/`eventText`/`subject`), chat row snippet in `NotificationListItem`, store-ordering verification. *Commit checkpoint.*
4. **Suppression feed segment** — `Thread.tsx` markRead-on-incoming; two-user dev click-through (§5 manual list). *Commit checkpoint.*
5. **QA deploy → device/panel check → prod deploy** (per `CLAUDE.local.md` sign-offs; prod migration via direct sequelize binary `--env production-ssl-disabled`).

## 7. Risks & open questions

1. **Schema bias (risk 1)** — mitigations in §2 (no default-scope include), §3 item 3 (conditional presenter include), and the §5 integration test proving a channel-only row renders. Residual: any *other* code path that assumes every notification has a document (email templates do — mitigated by rule 3; the archival/cleanup tasks need a read-through during build, noted below).
2. **markRead race (risk 4)** — the cursor guard runs at task-execution time on both paths, so a read that lands before the task suppresses cleanly; a read that lands after creates a notification that the client will clear on next view (acceptable, documented — no locks).
3. **Revival noise (risk 2)** — `createdAt` untouched + `orderedData` keyed on it ⇒ no re-sort, asserted byte-identical in tests. Residual product question: an aggregated row re-pings (unread dot) per new message even without moving — that is the intended chat semantics ("new stuff since you last looked"), accepted.
4. **Email (rule 3)** — enforced by the EmailsProcessor switch's default fall-through + explicit test. Open question: should a future settings UI ever offer per-channel email for chat, the single-boolean `NotificationEventDefaults` shape will need extending — out of scope now.
5. **Aggregate updates don't emit `notifications.update`** — `Notification` has only an `@AfterCreate` event hook, so a `messageCount` bump on an open panel won't live-refresh; the panel re-fetches on open. Options: add an explicit event schedule on the update path, or accept stale counts until reopen (Slack-like). **Recommend accept for v1**; note in the open questions for the user to confirm.
6. **Viewed-row history** — the partial unique index permits unlimited viewed chat rows; `CleanupOldNotificationsTask` prunes old viewed/archived rows — during build, confirm its where-clause covers the new event so quiet-channel rows don't linger unbounded.
7. **markRead write amplification** — one small UPDATE per incoming message while viewing. Fine at 3-person scale; if it ever matters, debounce client-side. Do not pre-build.
8. **Multi-tab edge** — a tab viewing the channel suppresses the notification for the whole user (the cursor is per-user). Matches chat-badge semantics today; document as intended.
