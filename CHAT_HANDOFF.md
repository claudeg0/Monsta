# Monsta chat — handoff

Status as of 2026-09-19. Everything described here is committed on branch
`chat` (commit `68ebdadf3`), branched from `main`. **Not pushed to origin.**

Read `AGENTS.md` (coding conventions) and `CLAUDE.local.md` (environments and
hard rules) first — they govern regardless of anything here.

---

## 1. What this is

A native chat feature added to this Outline fork, for a 3-person team.
Built and tested over roughly ten days against a live dev instance with real
devices (iPhone Safari, iPhone PWA, Android Chrome, desktop browsers).

**Working and verified on real devices:** DMs, group channels, live message
delivery, presence (online dot / "N online"), unread counts, optimistic send,
message edit and delete, per-person conversation hiding, group add and leave.

**The one path never tested end-to-end:** a hidden conversation reappearing
live when a new message arrives (see §7).

---

## 2. Environments — read before running anything

| Env | Location | Notes |
|---|---|---|
| **Production** | `/opt/outline` | LIVE, team uses daily. Runs upstream Outline, **not** this fork. Never touch. |
| **Dev** (this repo) | `/opt/Monsta` | App runs via `yarn dev` **on the host**, not in Docker. Postgres/Redis are in Docker. |
| QA | `monsta-qa*` containers | Separate, currently crash-looping. Not used by this work. |

- Dev app is served at **https://dev-wiki.immersivebeginnings.us** via a
  Cloudflare tunnel → `localhost:3000`.
- Dev DB: `docker exec monsta-postgres-1 psql -U user -d outline`
- The dev server is long-running with Vite HMR. **You do not need to restart
  it** — edits are picked up automatically.

### Verifying your change actually reached the device

This saved hours repeatedly. Vite serves unbundled modules in dev, so you can
curl the exact module the browser loads:

```bash
curl -s "https://dev-wiki.immersivebeginnings.us/static/app/scenes/Chat/Chat.tsx" | grep -c "someNewSymbol"
```

If that returns 0, the user is testing stale code and any bug report is noise.
This happened twice. An iOS PWA left open for hours keeps running the JS it
loaded at launch until force-quit — a pull-to-refresh is not enough.

### Quality gates

```bash
yarn tsc --noEmit -p .    # must be 0 errors
yarn lint                 # must be 0 errors; 178 warnings is the baseline
yarn vitest run --project app app/stores/ChatPresenceStore.test.ts
```

**The 178 lint warnings are pre-existing across the whole repo.** Do not try
to fix them; just confirm the count hasn't risen and that none are in files
you touched. `tsc` takes 2–4 minutes.

---

## 3. Data model

- **`channels`** — `type` is `dm` or `group`; `name` (groups only), `teamId`,
  `createdById`, `lastMessageAt`, `archivedAt` (**unused**, no route).
  A `dm` is *exactly two people*, deduplicated on create; its title and
  presence are derived client-side from "the other participant".
- **`channel_memberships`** — join row with two per-viewer fields:
  - `lastReadAt` — read cursor, drives unread counts.
  - `hiddenAt` — per-person conversation hiding (§6).
- **`messages`** — `data` (ProseMirror JSON, same restricted schema as
  Comment), `channelId`, `createdById`, `editedAt`, `parentMessageId`
  (column exists, **no threading UI**).

Migrations: `server/migrations/2026091415000{0,1,2}-*` and
`20260917120000-add-hidden-at-to-channel-memberships.js`. All applied to dev.

---

## 4. File map

**Server**
```
server/models/{Channel,ChannelMembership,Message}.ts
server/policies/{channel,message}.ts
server/presenters/{channel,message}.ts
server/routes/api/channels/{channels,schema}.ts
server/routes/api/messages/{messages,schema}.ts
server/services/websockets.ts            (rooms, presence — modified)
server/queues/processors/WebsocketsProcessor.ts  (broadcasts — modified)
server/types.ts                          (ChannelEvent, MessageEvent)
```

**Client**
```
app/models/{Channel,Message}.ts
app/stores/{ChannelsStore,MessagesStore,ChatPresenceStore}.ts
app/scenes/Chat/{Chat.tsx,openNewConversation.tsx}
app/scenes/Chat/components/{ChannelList,Thread,Composer,MessageEditor,
                            PeoplePicker,NewConversationDialog,AddPeopleDialog}.tsx
app/menus/{MessageMenu,MessageContextMenu,ChannelMenu,ChannelContextMenu}.tsx
app/hooks/{useMessageMenuAction,useChannelMenuAction}.tsx
app/components/{MessageDeleteDialog,ChannelDeleteDialog,ChannelLeaveDialog}.tsx
app/hooks/useVisualViewport.ts           (publishes CSS vars — modified)
app/components/WebsocketProvider.tsx     (chat + presence handlers — modified)
app/components/Sidebar/App.tsx           (unread dot — modified)
```

**API surface**: `channels.create|info|list|markRead|hide|addUser|leave`,
`messages.create|list|update|delete`.

---

## 5. ⚠️ Mobile layout — do not "clean up" these

Every item below was found on a physical device, cost multiple debugging
rounds, and **looks like removable cruft**. Each is commented at its site.
If you change any of them, you must re-test on a real iPhone.

1. **`Chat.tsx` `Viewport` needs `width: 100%`.**
   Layout's `Content` is a row flex container with `justify-content: center`,
   and the shared `Flex` sets neither width nor flex-grow. Without this the
   scene is shrink-to-fit and centered, leaving live page either side of it.
   Other scenes get this free from `Scene.tsx`'s `FillWidth`; this scene opts
   out of `<Scene>` deliberately (for the height chain) and must restate it.

2. **On mobile the scene is `position: fixed` + `top: var(--visual-top)`.**
   iOS Safari ignores `interactive-widget=resizes-content` (which *is*
   declared in the viewport meta and does work on Android). So with the
   keyboard open the layout viewport stays full height while the visible band
   is roughly half — the page behind the app can be dragged. Fixed removes the
   scene from flow; `--visual-top` (published per-frame by
   `useVisibleViewportVars`) tracks iOS's own panning so the scene stays glued
   to the visible band.

3. **`html`/`body` get `overflow: hidden` while the Chat scene is mounted**
   (effect in `Chat.tsx`, restored on unmount, mobile only).

4. **`MessageListInner` has `min-height: calc(100% + 1px)`. This is the single
   most important line in the feature.**
   iOS only hands a touch to a scroll container that actually has somewhere to
   scroll. A thread too short to overflow has *zero* scroll range, so Safari
   takes the drag and pans the page instead — the whole UI comes loose. The
   spare pixel guarantees the list is always a valid gesture target.
   Symptom if removed: "the chat moves like it's sitting on top of something
   else", **and only in conversations with fewer than ~5 messages.**
   Note the trick relies on the parent having a *definite* height; it does not
   transfer to content-sized elements.

5. **`touch-action`**: `none` on `Viewport` and on the composer `Form`,
   `pan-y` on `MessageList`. Necessary but **not sufficient** — proven on
   device: `touch-action` cannot refuse Safari's visual-viewport pan. Item 4
   is what actually fixes it.

6. **The composer must not become a scroll container.** Giving it
   `max-height` + `overflow-y: auto` reintroduces bug 4 (a short draft = zero
   scroll range). It therefore grows unbounded and a long draft squeezes the
   thread. This was tried, shipped, regressed, and reverted — don't redo it
   without a different approach and a device test.

7. **Flex children need `min-height: 0`** (`Thread`'s `Container` and
   `MessageList`). Without it `overflow-y` never produces a scroll region.

8. **`ContextMenu` is desktop-only by design** (`if (isMobile) return children`).
   Long-press was implemented via an opt-in flag, shipped, and **reverted**:
   it worked, but reintroduced the page-pan (mechanism never fully pinned) and
   the user preferred the ⋯ button. Right-click still works on desktop. If you
   revisit long-press, expect it to fight scrolling and iOS text selection —
   that guard is presumably why upstream added it.

---

## 6. Behaviour worth knowing

- **Optimistic send**: `Composer` builds the `Message` client-side with a
  `uuidv4()` id assigned **after** construction (so `Model.isNew` stays true
  and `save()` routes to create), adds it to the store, clears the input, then
  persists. `messages.create` accepts a client-supplied `id` so the server
  writes the same row — same convention as `comments.create`.
- **Unread counts** are computed server-side in one batched query
  (`unreadCountsFor` in `channels.ts`) and **exclude your own messages** —
  `lastReadAt` only advances when you open a channel, so without that
  exclusion sending a message marks the channel unread for its own author.
  The websocket handler applies the same exclusion when incrementing live.
- **Hiding a conversation** (`channels.hide`) sets `hiddenAt` **and** advances
  `lastReadAt`. `channels.list` filters out a channel only while
  `lastMessageAt <= hiddenAt`, so **it returns by itself when someone writes
  again** — no write on the message hot path, and a reply can't be stranded in
  a list its recipient made permanently invisible.
- **Add/leave** are groups-only and enforced server-side. You cannot leave if
  you're the last member (it would strand the channel, since nobody can add
  themselves back). Membership events publish as `channels.add_user` /
  `channels.remove_user`; `ChannelMembership` overrides `modelId` to report
  the **channel** id, because the socket layer needs it to move sockets in and
  out of the room and on removal the row is already gone.
- **Add/leave broadcasts go only to the affected user**, deliberately.
  Emitting the presented channel to everyone would also hand them
  `unreadCount: 0` and wipe other people's unread badges. Cost: other members'
  copy of `memberIds` is stale until their next fetch (affects only the
  "N online" count).

---

## 7. Open items

1. **Untested**: hidden conversation reappearing **live**. The data layer is
   verified correct. A fix was added (`WebsocketProvider` fetches a channel it
   doesn't recognise on `messages.create`) but never exercised on a device.
   *Test*: hide a conversation, have another account message it, confirm it
   returns without a reload and badges only the new messages.
2. **Not pushed.** Branch `chat` is local only. Pushing to `main` requires the
   user's explicit approval (`CLAUDE.local.md`).
3. **`.env` is gitignored**, so one fix is not captured in git: `URL` was
   changed from `http://129.158.217.122:3000` to the tunnel URL so it matches
   `.env.development`. If the environment is rebuilt, redo it — a mismatch
   breaks anything that origin-checks (e.g. the websocket upgrade guard in
   `server/services/websockets.ts`).
4. **`transports: ["websocket"]`** in `WebsocketProvider` has no polling
   fallback. If the websocket transport ever fails, realtime dies **silently
   and totally** while HTTP keeps working — which disguises it as "messages
   are slow". Worth adding `"polling"`; polling is confirmed working through
   the tunnel.
5. **PWA load speed is unmeasured, not slow.** Dev serves 1223 first-party
   modules individually and the service worker is disabled in development.
   Measure against a production build before optimising anything.
6. **No remove-other-people** from a group (self-leave only). No threading UI.
   No push notifications. `channels.archivedAt` exists and is unused.
7. **`app/scenes/Chat/components/MessageEditor.tsx`** no longer registers
   `SendOnEnter` (deleted): Enter inserts a newline, the send button submits,
   and `Keys` still provides Mod-Enter as a keyboard send.

---

## 8. How to work on this effectively

The single thing that made progress possible: **when a mobile bug is
reported, do not reason about the cause — put the value on screen and get a
screenshot.** A temporary fixed-position debug banner rendering live numbers
(`GAP`, `SCROLLTOP`, `PAGE_OVERFLOW`, `LIST_RANGE`, computed `touch-action`)
resolved in one round what days of plausible-sounding CSS theories did not.

Three separate times a confident diagnosis was wrong and a number on screen
corrected it. `LIST_RANGE: 0` is what cracked the worst bug in the project.

Two recurring bug shapes worth checking for proactively:

- **Two pieces written at different times that never met.** `messages.delete`
  failed authorization for everyone because it didn't eager-load `createdBy`,
  which the policy needs (`isTeamModel` returns false for an unloaded
  association, and `and()` short-circuits before the admin check). `update`
  worked only because it happened to load it for presentation. Same shape as
  the hidden-conversation gap in §7.1.
- **Mobile behaviour that depends on content volume.** If something works in
  one conversation and not another, check how many messages each has.
