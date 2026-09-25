# Video calling in Monsta — implementation plan (Daily.co)

## 1. Summary & decisions

- **Greenfield**: no existing call/video/WebRTC code anywhere in `app/`, `server/`, `shared/`, `plugins/`.
- **Provider: Daily.co** (user-selected). Managed video API built for embedding: prebuilt UI (rendered via their JS SDK in an iframe-style frame), private rooms, per-user meeting tokens minted server-side. Free tier is **10,000 participant-minutes/month** (≈55 hours of 3-person calls), then $0.004/participant-minute — far more than a 3-person team needs. Media flows browser↔Daily directly, so the Cloudflare tunnel and self-hosted infra are untouched. Best mobile-browser support of the candidates, which matters for the iPhone PWA test matrix.
- **Placement: core, not a plugin.** Chat is core (`CHAT_HANDOFF.md`), and the client plugin API (`app/utils/PluginManager.ts`) has no hooks for chat UI or routes. Config plumbing mimics the Slack/Dropbox `@Public` env patterns.
- **Call model**: at most one active call per channel. A call = one Daily room named with an unguessable uuid, created per call. Call state is **persisted on `channels`** (a refresh/reconnect sees it via the presenter) **plus websocket events** for live updates — mirroring how `lastMessageAt` + `messages.create` already work.
- **Last-person-ends** (revised review fix 1): anyone in the channel can end a call, but the UI only offers **End** to the last remaining participant — participant count comes from `@daily-co/daily-js`, which moves into v1 scope. Everyone else gets **Leave** (close overlay, call continues). End requires a confirm dialog. There is deliberately **no** starter/creator/admin rule and no extra 403 path on `channels.endCall`: the platform is invite-only trusted users, and server-side last-participant verification would mean a Daily round-trip on every end — unnecessary complexity for v1. Client-side enforcement via participant count is sufficient.
- **Stale calls self-heal in v1** (revised review fix 2): the last leaver's daily-js client detects the single-participant state and ends the call (normal path, emits `channels.call_ended`); a signature-verified Daily webhook (`meeting.ended`, fires ~20s after the room empties) clears abandoned state (crash/force-quit/network-loss path). Worst-case stale banner ≈20s. Room `exp` (+24h) is a **join-backstop only**, not a call-length cap.
- **Provider seam**: all Daily-specific logic lives behind `server/utils/daily.ts` + the `CallStore` `{url, token}` contract, so swapping providers later touches only the util and the route mapping; the client is unchanged.

## 2. Architecture overview

```
┌──────────────── Monsta (existing) ────────────────┐      ┌──── Daily.co ────┐
│  Chat UI ──► channels.startCall / endCall (API)    │      │  Rooms REST      │
│       ▲          │ policy: channel member          │────► │  Meeting tokens  │
│       │ events   │                                  │      │  SFU media (UDP) │
│  WebsocketProvider ◄── WebsocketsProcessor ─────── │      │  (browser-direct)│
│       │ channels.call_started / call_ended         │      └──────────────────┘
│  CallOverlay (daily-js frame, room url + token) ─── ┼────► browser ► Daily SFU
│  POST /api/daily.webhook ◄── meeting.ended (HMAC) ──┤  Daily ──► Monsta
└────────────────────────────────────────────────────┘
```

- Monsta's socket.io layer is used **only** for call signaling (start/end/join notifications). All audio/video media and in-call signaling go browser↔Daily, never through Monsta's server or the Cloudflare tunnel. The webhook is the one reverse path: Daily → Monsta, for abandonment cleanup.
- CSP needs **no change**: `server/middlewares/csp.ts` already allows `frame-src *`, `connect-src *`, `media-src *`, and no Permissions-Policy header is set (`server/services/web.ts`). `@daily-co/daily-js` is bundled by Vite (no `script-src` addition), and the frame it creates is covered by the existing wildcards.

## 3. Data model & migration

`yarn sequelize migration:create --name=add-call-to-channels` (dev DB only for now; prod migration at deploy time per §10):

| column | type | notes |
|---|---|---|
| `callId` | `DataTypes.UUID` / varchar(36), **unique index** | also the Daily room name |
| `callStartedAt` | `DataTypes.DATE` | |
| `callStartedById` | `DataTypes.UUID`, FK → `users` | |

All nullable; call end (route or webhook) nulls all three. A **separate `calls` history table is deliberately deferred** (§11) — the nullable-column design carries v1 and doesn't block adding history later.

## 4. API & event contracts

### 4.1 `POST /api/channels.startCall` — start or join (idempotent)

Request (`server/routes/api/channels/schema.ts`, zod, mirrors `ChannelsMarkReadSchema` at `schema.ts:30-32`):
```json
{ "id": "<channel uuid>" }
```
Handler: `auth()` → `rateLimiter(RateLimiterStrategy.OneHundredPerMinute)` → `validate` → `transaction()` → lock channel row (`lock: Transaction.LOCK.UPDATE`, closing the double-start race) → policy `can(channel, "startCall")` → branch:

- **`channel.callId == null` (start)**: create Daily room → set columns → emit event → mint token → respond.
- **`channel.callId != null` (join)**: skip room creation → mint fresh token for the existing room → respond.

Response: `{ "data": presentChannel(channel), "call": { "id", "url", "token" }, "policies": [...] }` — `policies` included per API convention (no End/Leave gating rides on it; that decision is participant-count-based, §7).

Errors: 403 policy / not-a-member; 404 unknown channel; 503 `VideoProviderError` (new class in `server/errors.ts`) when Daily REST fails — channel state untouched.

### 4.2 `POST /api/channels.endCall`

Request `{ "id": "<channel uuid>" }`. Policy is the same single rule as `startCall`: **channel member** — no starter/creator/admin restriction (revised review fix 1), so no associated 403 path. Clears columns (transaction) → emits `channels.call_ended` → best-effort `DELETE` the Daily room (Daily kicks remaining participants; failure is logged, room `exp` eventually refuses new joins). Idempotent: ending an idle channel is a no-op 200.

### 4.3 Daily REST calls (`server/utils/daily.ts`, global `fetch`, Bearer `DAILY_API_KEY`)

| purpose | call | body / notes |
|---|---|---|
| create room | `POST https://api.daily.co/v1/rooms` | `{ "name": "<callId uuid>", "privacy": "private", "properties": { "exp": <unix s, creation+24h>, "enable_chat": false, "enable_people_ui": true, "max_participants": 20 } }` — chat UI off because Monsta chat is the chat |
| mint token | `POST https://api.daily.co/v1/meeting-tokens` | `{ "properties": { "room_name": "<callId>", "user_name": "<display name>", "user_id": "<user id>", "exp": <unix s, mint+24h> } }` — fresh token per join |
| delete room | `DELETE https://api.daily.co/v1/rooms/<callId>` | best-effort |

- **`exp` is a join-backstop only.** Do **not** set `eject_at_room_exp`: `exp` is creation-relative and would hard-cap call length at creation+24h. With `eject_at_room_exp` absent, an ongoing call is never cut off; `exp` only refuses *new joins* to rooms older than 24h (abandoned-room backstop; a marathon call's late joiners being refused after hour 24 is an accepted edge for v1).
- Tokens are minted per join with mint+24h exp, so token expiry mid-call is not a scenario either.

`url` returned to the client: `https://<DAILY_DOMAIN>/<callId>`; the daily-js frame joins `${url}` with the token.

### 4.4 Websocket events

Defined in `server/types.ts` (`ChannelEvent`, `:414-431`), emitted with custom names via the existing options pattern (`saveWithCtx(ctx, { name: "call_started" })`, mirroring `add_user` at `channels.ts:340`), broadcast by new cases in `server/queues/processors/WebsocketsProcessor.ts` to room `channel-${event.modelId}` (pattern at `:621-705`):

- **`channels.call_started`** → `{ "channelId", "callId", "startedById", "startedAt" }` — client does `channel.updateData({ callId, callStartedAt, callStartedById })`.
- **`channels.call_ended`** → `{ "channelId" }` — client does `channel.updateData({ callId: null, callStartedAt: null, callStartedById: null })` and closes the overlay if joined.

**Emit raw payloads, not presented channels**: `presentChannel` throws on unloaded associations (`WebsocketsProcessor.ts:678-685` gotcha), and the add/remove-user broadcasts reach only the affected user (`:658-663`) — that pattern must not be copied; everyone in the channel room needs call events.

### 4.5 `POST /api/daily.webhook` — Daily → Monsta (public, signature-verified)

Reverse path for abandoned calls. New file `server/routes/api/daily.ts`, following existing API route patterns (mounted with the rest of `server/routes/api/`; verify against the channels precedent).

- **No `auth()` middleware** — public by design; instead verifies the HMAC signature of the **raw request body** against `DAILY_WEBHOOK_SECRET` before acting. Bad signature → 400 + log, no state change.
- Endpoint is inactive (404) when `DAILY_WEBHOOK_SECRET` is unset.
- On **`meeting.ended`** (fires ~20s after the last participant leaves): look up the channel by `callId == room name`, null the three call columns. **Idempotent** — replaying or receiving a webhook for an already-cleared channel is a no-op 200 (replay/ordering tolerance is acceptable by construction).
- Unknown room names → 200 no-op (log at debug).

## 5. Call lifecycle & failure branches

States per channel: `idle → active(callId, startedBy, startedAt) → idle`. Joining is not a state change. End transitions come from two paths: the last leaver's client (§7) or the webhook (§4.5).

| branch | behavior |
|---|---|
| two members start simultaneously | row lock in `startCall` serializes them; second sees `callId` set → join path. One room, no split-brain |
| Daily REST down at start | no DB write; `VideoProviderError` → 503; UI shows toast, channel stays `idle` |
| DB write fails after room created | compensating `DELETE` room, best-effort, logged |
| member ends while others remain in the room | the client never offers End unless the participant count is 1 (self); the API itself stays member-gated only — trusted, invite-only users, and a server-side last-participant check would add a Daily round-trip to every end |
| last participant force-quits / crashes / drops without tapping Leave | Daily fires `meeting.ended` ~20s after the room empties → webhook clears channel state. Worst-case stale banner ≈20s |
| late joiner races the `meeting.ended` webhook | webhook clears `callId` while a join is in flight; the freshly minted token is for a room Daily is deleting → Daily renders its error state in the frame; the client surfaces the existing "Open in new tab"/retry affordance. Documented race, no crash path |
| member removed from channel mid-call | socket leaves the room but the Daily token stays valid until the call ends — documented v1 limitation (3-person team, low risk); §11 fix: end the call on member removal |
| channel deleted mid-call | existing `channels.delete` flow removes it from stores; `CallStore` also closes the overlay if its channel disappears |
| token/room expiry | per-join tokens (mint+24h) and room `exp` as a join-backstop only (no `eject_at_room_exp`) mean an ongoing call is never cut off; only new joins to rooms older than 24h are refused (accepted edge) |
| socket reconnect | persisted `callId` survives on the `Channel` model; on reconnect the client refetches `channels.list` (verify/add in `WebsocketProvider`) — no new snapshot machinery |
| Daily frame fails to get camera/mic (PWA quirks) | the daily-js `error` event surfaces Daily's own error state plus our "Open in new tab" fallback link |

## 6. Server changes (file-by-file)

1. **`server/env.ts`** — `DAILY_API_KEY` (server-only), `DAILY_WEBHOOK_SECRET` (server-only), and `@Public @IsOptional() DAILY_DOMAIN`. Auto-flows to `window.env` via the `@Public` → `presentEnv` → `index.html` pipeline. Feature enabled iff key + domain set; webhook active only when the secret is set.
2. **Migration** — §3; run on dev DB.
3. **`server/models/Channel.ts`** — three columns + `startCall(user)` / `endCall(user)` instance methods (Daily calls + column updates, transaction-friendly), keeping routes thin per AGENTS.md.
4. **`server/utils/daily.ts`** (new) — §4.3; errors mapped to `server/errors.ts` (`VideoProviderError`, plus typed wraps for fetch failures).
5. **`server/policies/channel.ts:17`** — `startCall` and `endCall` together alongside `read`: channel members only (`isTeamModel` + `isChannelMember`). **One rule — no separate end restriction** (revised review fix 1).
6. **`server/routes/api/channels/{channels,schema}.ts`** — two routes (§4.1, §4.2) following `channels.markRead` (`channels.ts:229-261`); zod schemas colocated; directory auto-mounts (nothing to add to `server/routes/api/index.ts`).
7. **`server/routes/api/daily.ts`** (new) — the webhook route (§4.5): no `auth()`, HMAC verification over the raw body, `meeting.ended` handling, idempotent clear.
8. **`server/presenters/channel.ts:17-46`** — add `callId`, `callStartedAt`, `callStartedById`.
9. **`server/types.ts:414-431`** — extend `ChannelEvent`.
10. **`server/queues/processors/WebsocketsProcessor.ts`** — two broadcast cases (§4.4).
11. **No changes** to `server/services/websockets.ts` — channel rooms already exist and are maintained on membership changes; there is no client→server socket traffic today and none is needed.

## 7. Client changes (file-by-file)

1. **`app/models/Channel.ts:20-66`** — `@Field @observable callId / callStartedAt / callStartedById` (persisted-field pattern).
2. **`app/stores/ChannelsStore.ts:20-27`** — `startCall(channelId)` / `endCall(channelId)` mirroring `markRead`.
3. **New `app/stores/CallStore.ts`**, registered in `app/stores/RootStore.ts` — ephemeral "call I'm in": `{ channelId, isOpen, frame: DailyCall | null, participantCount }`, `open()`/`close()`. Persisted call state stays on the `Channel` model.
4. **`app/components/WebsocketProvider.tsx`** — new `useCallHandlers` hook (mirror `useChatHandlers` at `:682-732`), registered at both sites (`:996`, `:1019`):
   - `channels.call_started` → `channel.updateData(...)`; if started by someone else and I'm not in that call → toast with a **Join** action (existing Toasts pattern).
   - `channels.call_ended` → `channel.updateData(... nulls)`; close overlay if `CallStore.channelId` matches.
   - On socket reconnect: refetch `channels.list` for reconciliation (persisted state makes this sufficient).
5. **UI** (all gated on `env.DAILY_DOMAIN`):
   - **Start/Join button** — Chat header `actions` slot (`app/scenes/Chat/Chat.tsx:159-165`), shown when a channel is open; icon/label flips on `channel.callId` (video-call icon from the existing icon set).
   - **Active-call indicator** — `ChannelList` row (`app/scenes/Chat/components/ChannelList.tsx`): icon + "Call" affordance when `channel.callId` set; clicking joins.
   - **In-thread banner** — `Thread.tsx` above `MessageList`: "Call in progress — Join" when active and not joined.
   - **New `app/scenes/Chat/components/CallOverlay.tsx`** — portal to `document.body` (deliberately **not** inside the Chat scene flex chain — avoids every CHAT_HANDOFF §5 trap), `position: fixed; inset: 0; height: 100dvh`, z-index `depths.modal` (`shared/styles/depths.ts:10-11`), own body-scroll lock (Chat's lock is scene-local and unmounts on navigation), safe-area padding via `env(safe-area-inset-*)`. **Uses `@daily-co/daily-js`** (revised review fix 1 — moves into v1): `DailyIframe.createFrame(wrapper, {...})` renders Daily's prebuilt UI in an iframe-style frame; join with the room url + token from `startCall`; listen to `participant-joined`/`participant-left` to maintain `participantCount`, and `left-meeting`/`error` to close the overlay or surface Daily's error state. Header: **Leave** (always: `frame.leave()` + close overlay; call continues for everyone) and **End for everyone** — rendered only when `participantCount === 1` (self), behind a `ConfirmationDialog`-pattern confirm, then `channels.endCall` — plus an "Open in new tab" fallback link. Full-screen at all breakpoints.
6. **i18n** — `t()` as usual; extraction is automatic (never hand-edit locale files).

## 8. Security & privacy

- Private Daily rooms + server-minted meeting tokens (user name/id bound) — the room URL alone doesn't grant join.
- `startCall`/`endCall` both require channel membership (the single policy rule, §6.5); end has no additional restriction by design (revised review fix 1).
- **Webhook endpoint is public but signature-verified**: HMAC of the raw body against `DAILY_WEBHOOK_SECRET`, 400 + log on bad signature, inactive when the secret is unset. Replay/ordering tolerance is acceptable — the handler only ever idempotently clears nullable columns. Daily doesn't provide nonce/timestamp material; nothing actionable rides on ordering. The global per-IP rate limiter still applies to it (unauthenticated requests are per-IP by default).
- Unguessable room names (uuid `callId`); room `exp` (+24h) refuses new joins to abandoned rooms; room deleted on end.
- `DAILY_API_KEY` and `DAILY_WEBHOOK_SECRET` never `@Public`; only `DAILY_DOMAIN` reaches the client.
- Rate limiter on both channel endpoints; zod validation; errors carry no provider internals.
- No CSP changes needed (`daily-js` is bundled; the frame it creates is covered by existing `frame-src`/`connect-src` wildcards). Optional later hardening: scoped Permissions-Policy allowing camera/mic for `*.daily.co` only.
- `X-Frame-Options: SAMEORIGIN` on Monsta pages is irrelevant here (Monsta embeds Daily, not vice versa).

## 9. Mobile / PWA deep-dive

Why Daily was picked: of the candidates it has the strongest mobile-browser story (Jitsi officially steers mobile users to native apps). Remaining device risks and mitigations:

- **getUserMedia in a cross-origin iframe on iOS Safari** requires `allow="camera; microphone"` on the frame (daily-js sets this on the frame it creates). Historically buggy on older iOS; current iOS handles it. **Verify on a physical iPhone at milestone 8, not at the end.**
- **iPhone PWA (standalone)** — the stale-JS trap cuts both ways (review fix 3): the PWA runs the JS it loaded at launch until force-quit, so an iPhone test round can be silently exercising *old code* while you believe it's new. **Gate every iPhone test round on the curl-the-module trick** (`CHAT_HANDOFF.md:44-49`): confirm the new symbol is served, then force-quit and relaunch the PWA, *then* record results.
- **Viewport**: the overlay is a body-level portal with its own `overflow: hidden`; there is no page behind it to pan (unlike Chat), so the `--visual-top` machinery isn't needed — plain `fixed; inset: 0; height: 100dvh; overscroll-behavior: none; touch-action: none` suffices. Device-test anyway; iOS lies about heights in creative ways.
- **Notches/home indicators**: pad the overlay header with `env(safe-area-inset-*)`.
- **Screen share**: iOS Safari lacks `getDisplayMedia` — Daily hides the button itself; nothing to do.
- **Service worker**: caches only same-origin `/static` assets; never intercepts Daily traffic — no conflict.
- **Audio routing** (Bluetooth/earpiece): handled inside Daily's prebuilt UI.

**Per-device test checklist** (start, second participant joins, both see/hear each other, Leave/End; then: refresh mid-call on one device; permission-denied path; "Open in new tab" path; last-participant vs non-last End affordance):
- [ ] Desktop Chrome
- [ ] iPhone Safari
- [ ] iPhone PWA (installed)
- [ ] Android Chrome

## 10. Environments, deployment & rollout

- **Dev** (`/opt/Monsta`): user creates a Daily account (free tier), generates an API key, notes the domain; add `DAILY_API_KEY`, `DAILY_WEBHOOK_SECRET`, `DAILY_DOMAIN` to `/opt/Monsta/.env` (no pre-existing secrets touched); in the Daily dashboard register the webhook URL `https://dev-wiki.immersivebeginnings.us/api/daily.webhook`; `yarn dev` picks it up. Run the migration on the dev DB (`yarn db:migrate` — allowed freely).
- **QA first** (`/opt/monsta-qa-stack`, `https://qa-wiki.immersivebeginnings.us`): deploy the branch there, set QA env vars + webhook URL, and run the device matrix before prod. QA DB has no volume — fine for migration rehearsal.
- **Prod** (`/home/ubuntu/outline`) — every step needs explicit sign-off per `CLAUDE.local.md`:
  1. Add the three vars to `/home/ubuntu/outline/.env` and register the prod webhook URL in the Daily dashboard.
  2. **Rebuild `monsta-prod-base` first** — `docker compose build` on the runtime Dockerfile does *not* pick up source changes (it copies `--from=base`); build the base image from `/opt/Monsta`, then the runtime image, then **verify a known-new symbol inside the image**.
  3. Run the channels migration with the direct sequelize binary (`--env production-ssl-disabled`), not `yarn db:migrate`.
  4. Restart the compose stack and smoke-test a real call (including a force-quit abandonment to see the webhook clear state).
- Rollback: revert image; call columns are nullable and inert without the env vars (UI hidden when `DAILY_DOMAIN` absent — the feature degrades gracefully).

## 11. Beyond v1 (deferred, with hooks)

The two previously-deferred stale-call fixes (webhook auto-ender, last-leaver client heuristic) are **promoted into v1** by revision. Remaining deferred items:

| item | why defer | hook left in place |
|---|---|---|
| System message on call start/end in the thread | nice history, but bumps unread semantics need a decision | messages schema already handles ProseMirror JSON; emit from the same routes later |
| Ringing / incoming-call sound | no push-notification infra exists at all; toast is enough for 3 people | `channels.call_started` handler is where it'd go |
| Call history / `calls` table | zero-history design carries v1 | nullable columns migrate cleanly to a future table; Daily dashboard has usage data meanwhile |
| Member removed mid-call | 3-person team, low risk | end call on `channels.remove_user` later |
| Recordings / transcription | storage + privacy decisions | Daily API supports it; out of scope |
| Guest join links, document embeds | separate features | provider seam in `server/utils/daily.ts` |

**Alternatives considered**: *room-per-channel* (persistent room per channel id — no room creation on start, but rooms accumulate and naming is guessable) → rejected in favor of room-per-call with `exp`. *Separate `calls` table now* → rejected for v1 (extra join + history UI nobody asked for yet). *Plugin* → rejected (no client hook exists; would add Hook types and touch Chat anyway). *Server-side last-participant check on endCall* → rejected (Daily round-trip per end; trusted invite-only users make client-side count gating sufficient).

## 12. Testing plan

- **Unit** (colocated `.test.ts`, existing patterns):
  - `server/utils/daily.ts` — `fetch` mocked: room/token/delete happy paths, error mapping, timeout handling; room creation does **not** set `eject_at_room_exp`.
  - `channels.startCall` — start path, join-idempotency, double-start race (lock), non-member 403, unknown channel 404, Daily-down 503 (no DB write), response shape.
  - `channels.endCall` — plain member **allowed** (no 403 case — revised fix 1), idempotent no-op, event emitted, room delete failure still 200.
  - `daily.webhook` — good signature clears state; **bad signature rejected 400 with no state change**; unknown room no-op; replayed `meeting.ended` idempotent; endpoint 404 when secret unset.
  - `WebsocketsProcessor` — both cases emit the exact payload to `channel-<id>`.
  - Client: `CallStore`, `useCallHandlers` (precedent: `app/stores/ChatPresenceStore.test.ts`), `Channel` new fields round-trip, **End button gated on `participantCount === 1`** (daily-js mocked), Leave always available.
- **Quality gates**: `yarn tsc --noEmit -p .` → 0 errors; `yarn lint` → 0 errors, warning count ≤178 baseline; `yarn vitest run` for touched files.
- **Manual E2E**: §9 checklist, **starting every iPhone/PWA round with the curl-verify + force-quit ritual** before recording results. Plus:
  - (a) last participant sees **End**, non-last sees only **Leave**;
  - (b) **force-quit the last client → webhook clears channel state within ~20s**;
  - (c) webhook call with a bad signature is rejected (simulated via curl);
  - (d) Daily-down at start behaves as before (503, no state change);
  - (e) a plain member can end a call via the API when last (no 403);
  - (f) two simultaneous calls in different channels don't cross-talk; unread badges unaffected by call events; overlay survives socket reconnect; late joiner after refresh gets join (not start); join-vs-`meeting.ended` race surfaces the retry affordance without crashing.

## 13. Build order

1. Daily account + dev env vars (`DAILY_API_KEY`, `DAILY_WEBHOOK_SECRET`, `DAILY_DOMAIN`) + register the dev webhook URL in the Daily dashboard (user action, unblocked now).
2. Migration → `Channel` model → presenter → `types.ts` → policy (single members-only rule).
3. `server/utils/daily.ts` + tests.
4. Add the `@daily-co/daily-js` dependency (`yarn add`).
5. `channels.startCall`/`channels.endCall` routes + schemas + `WebsocketsProcessor` cases.
6. Webhook endpoint `server/routes/api/daily.ts` (HMAC verification, `meeting.ended`, idempotent clear) + tests.
7. Client: model fields, store methods, `CallStore`, `useCallHandlers`.
8. Client: Start/Join button, ChannelList indicator, thread banner, `CallOverlay` with the daily-js Leave/End-by-participant-count logic — **then device-test on a real iPhone before polishing**.
9. Unit gates + full device matrix (including the webhook abandonment case).
10. QA deploy → device matrix again → prod deploy (§10 approvals).
