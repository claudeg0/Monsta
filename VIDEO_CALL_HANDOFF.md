# Monsta video calls — handoff

Status as of 2026-09-22. Everything described here is on branch
`feature/video-calls`, **uncommitted** (working tree only) and **not
pushed**. Server side was already built and tested when this pass started;
this pass finished the client side, fixed two pre-existing build gaps, and
verified the whole thing compiles, lints, and passes tests.

Read `AGENTS.md` (coding conventions), `CLAUDE.local.md` (environments and
hard rules), and `CHAT_HANDOFF.md` (the chat feature this is built on top
of) first — they govern regardless of anything here. The design doc is
`docs/video-call-plan.md`; this file is status and a test guide, not a
second copy of the plan.

---

## 1. What this is

Native video calling for Monsta's chat, using **Daily.co** (managed,
user-selected — see `docs/video-call-plan.md` §1 for why, including why it's
Daily and not a self-hosted option). At most one active call per channel.
Server side was built and unit-tested against a real HTTP mock of the Daily
API before this pass began; this pass added everything on the client -
starting/joining/leaving/ending a call from the UI - and got the whole
branch back to a clean, tested state.

**Not yet done by anyone:** an actual click-through in a real browser. There
was no browser tooling available in the session that did the client work, so
everything was verified by compiling, linting, testing, and confirming the
dev server serves the current code - not by using the feature. See §4.

---

## 2. Environments

Same three as `CLAUDE.local.md` describes generally. For this feature
specifically:

| Env | Daily configured? | Notes |
|---|---|---|
| **Dev** (`/opt/Monsta`) | Yes - `.env` already has `DAILY_API_KEY`, `DAILY_WEBHOOK_SECRET`, `DAILY_DOMAIN` | This is where to test (see §4). |
| QA / Production | Not yet | Nothing to do here until this is merged and deployed - out of scope for this handoff. |

**Known operational gap found and fixed during this pass:** the dev
frontend (`yarn vite:dev`, port 3001) was dead - its `concurrently` parent
had zero children left, for reasons unknown (not something this pass did).
The backend (`dev:backend`'s nodemon, port 3000) was fine and independent -
it had already become an orphan of its own `concurrently` wrapper and kept
running normally. Restarted with:

```bash
cd /opt/Monsta && nohup yarn vite:dev > /tmp/vite-dev.log 2>&1 &
```

If `https://dev-wiki.immersivebeginnings.us/static/app/...` ever serves the
SPA shell (`<!doctype html>...`) instead of raw `.tsx` source, that's this
same symptom - check `ss -ltnp | grep :3001` and restart if it's not
listening. `tail -f /tmp/vite-dev.log` shows optimizer/HMR activity once
it's up.

---

## 3. What shipped this pass (client side)

**New files**
```
app/stores/CallStore.ts              - tracks "am I in a call" (local, not persisted)
app/scenes/Chat/joinCall.ts          - shared start-or-join-then-open-overlay helper
app/scenes/Chat/components/CallOverlay.tsx  - full-screen call UI (daily-js frame)
```

**Modified**
```
app/models/Channel.ts                - callId / callStartedAt / callStartedById fields, callInProgress getter
app/stores/ChannelsStore.ts          - startCall() / endCall() actions
app/stores/RootStore.ts              - registers CallStore
app/components/WebsocketProvider.tsx - channels.call_started / call_ended handlers,
                                        join toast, reconnect reconciliation
app/scenes/Chat/Chat.tsx             - call button in the header (gated on env.DAILY_DOMAIN)
app/scenes/Chat/components/ChannelList.tsx - live-call badge per row, click to join
app/scenes/Chat/components/Thread.tsx      - "Call in progress" banner above the thread
```

**Also fixed (pre-existing, not from this pass, but blocking a clean build)**
```
plugins/webhooks/server/tasks/DeliverWebhookTask.ts
    - its exhaustive switch over channel events didn't know about
      channels.call_started/call_ended; added to the existing
      "chat is ignored" branch.
server/utils/daily.test.ts
    - a bad HttpResponse<...> generic; typed the helper as () => Response instead.
server/routes/api/daily.test.ts   (new)
    - the Daily webhook route (signature verification, idempotent
      call-clearing, the {"test":"test"} connectivity ping) had no test
      coverage before this pass. 7 tests, all passing.
```

### Design notes worth knowing

- **CallStore vs. Channel model**: whether a channel *has* an active call is
  shared state on the `Channel` model (`callId` etc., synced from the
  server via REST + websocket events). Whether *this browser tab* has
  joined it is separate, ephemeral state in `CallStore` - a call can be
  live in a channel with nobody from this tab in it.
- **The daily-js frame instance itself lives in `CallOverlay`**, not in any
  store - nothing outside that one component needs it.
- **Four places can trigger "start or join a call"**: the Chat header
  button, the channel list's live-call badge, the in-thread banner, and the
  "Join" action on the call-started toast. All four call
  `app/scenes/Chat/joinCall.ts` rather than duplicating the
  `startCall()` + `callStore.open()` + error-toast sequence.
- **The "End for everyone" confirmation is inline inside `CallOverlay`**,
  not the app's usual `dialogs.openModal()` / `ConfirmationDialog`
  machinery. Deliberate: that machinery renders through a separate portal
  at the same z-index (`depths.modal`) as the call overlay, and stacking
  order between two same-z-index portals from different mount points was
  judged too easy to get wrong silently - keeping the confirm state local
  to `CallOverlay` sidesteps the question entirely. If you'd rather use the
  shared dialog pattern for consistency, that's a reasonable call to
  revisit, but verify the stacking on a real device first if you do.
- **The header also has an "Open in new tab" link** (a plain `<a>`, not a
  button - `NudeButton`/`ActionButton` in this app can't render as an
  anchor) - a fallback for the embedded frame failing to get camera/mic
  access, a documented PWA quirk in `CHAT_HANDOFF.md` §5. Untested, since
  it needs a real device to trigger.

---

## 4. How to test

You'll need **two accounts** (or one account in two browser sessions - e.g.
one normal window, one private/incognito) since a call needs someone to
join. Test against **dev**, not QA or production:

**URL:** `https://dev-wiki.immersivebeginnings.us`

### Automated checks (already run, all green - rerun if you change anything)

```bash
cd /opt/Monsta
yarn tsc --noEmit -p .                              # 2-4 min, must be 0 errors
yarn lint                                            # must be 0 errors, 178 warnings baseline
yarn vitest run --project server server/routes/api/channels/channels.test.ts \
  server/routes/api/daily.test.ts server/utils/daily.test.ts
yarn vitest run --project app app/stores/ChatPresenceStore.test.ts
```

### Manual click-through

1. **Sign in as two different users**, each in their own browser
   window/profile (or one normal + one incognito).
2. Go to **Chat** (left sidebar) in both.
3. **User A**: open (or start) a DM or group conversation that includes
   User B.
4. **Start the call**: click the camera icon in the Chat header (top
   right, next to "new message"). It's only there once a conversation is
   open - if you don't see it, confirm `.env`'s `DAILY_DOMAIN` is set (it
   already is in dev) and that the frontend actually picked it up (hard
   refresh; `window.env.DAILY_DOMAIN` in the browser console should be
   `immerseb.daily.co`).
5. The full-screen call overlay should open and join automatically -
   you should see Daily's own prebuilt call UI (camera/mic, participant
   tiles) inside it.
6. **User B**, without having clicked anything yet, should see:
   - A **toast** ("Call started in ...") with a **Join** action, if they're
     not currently looking at that conversation.
   - A **green badge** on that conversation's row in the channel list -
     clicking it should both open the conversation and join the call.
   - If they *are* looking at the thread already, a **"Call in
     progress — Join"** banner above the message list.
7. **User B joins** (via any of the above). Both should now see each other
   in the Daily call UI, and the header's "Joining…" label should flip to
   "Call" once fully connected.
8. **Leave vs. End**:
   - Either user clicking **Leave** should close their own overlay and
     leave the call - it should keep running for the other person.
   - With two people in the call, neither should see an "End for
     everyone" button (only the *last* remaining participant gets it).
   - Have one person leave, then confirm the remaining person now sees
     "End for everyone", click it, confirm the inline prompt, and verify
     the call actually ends (both the badge and banner should disappear;
     if the other tab is still open to the conversation, it should update
     live via the websocket event without a refresh).
9. **Abandoned-call self-heal** (the one path §7.1 of
   `docs/video-call-plan.md` calls out as never device-tested): join a
   call, then force-quit the tab/browser instead of clicking Leave. Within
   about 20 seconds, the call should clear itself for anyone still
   watching that conversation (via the Daily `meeting.ended` webhook →
   `server/routes/api/daily.ts`). This is the single highest-value manual
   test to run, since it's the one thing that couldn't be verified any
   other way.
10. **Mobile**: if you can, repeat at least steps 4-8 on an actual phone
    (iOS Safari and/or PWA) - the chat feature this is built on top of has
    a long history of mobile-only bugs (`CHAT_HANDOFF.md` §5), and none of
    the call UI has been checked on a real device yet.

### If something looks stale

Same trick `CHAT_HANDOFF.md` documents for the chat feature - Vite serves
unbundled modules in dev, so you can confirm the browser is actually
running current code:

```bash
curl -s "https://dev-wiki.immersivebeginnings.us/static/app/scenes/Chat/components/CallOverlay.tsx" | grep -c "someSymbolYouJustEdited"
```

A `0` means the browser (or Vite itself - see §2) is serving something
stale, not that your change is broken.

---

## 5. Open items

Carried over from `docs/video-call-plan.md` §7 plus what this pass found:

1. **No real browser test yet** - everything in §4 is written but unrun by
   this pass (no browser tooling in that session). This is the main thing
   to do next.
2. **"Open in new tab" fallback** (§3 above) is unverified - needs a
   device where the embedded frame actually fails to get camera/mic.
3. **Not pushed, not committed.** Branch `feature/video-calls` is local
   only, same as the rest of this work. Committing/pushing needs your
   explicit go-ahead per `CLAUDE.local.md`.
4. **The Vite frontend dying** (§2) happened for unknown reasons before
   this pass started - worth keeping an eye on whether it recurs, since
   nothing here explains why.
5. Everything else from `docs/video-call-plan.md` §7 (member-removed-mid-
   call is a documented v1 limitation, no `calls` history table yet, etc.)
   still applies unchanged.
