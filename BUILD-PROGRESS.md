# Chat notifications — build progress

Plan: `docs/chat-notifications-plan.md`. Branch: `feature/chat-notifications`.

## Segments (plan §6 build order)

1. **Schema segment** — done. Commit `849865647`.
2. **Pipeline segment** — done. Commit `e039bd19b`.
3. **Client segment** — done. Commit `93b9be99b`.
4. **Suppression feed segment** — done. Commit `911c6fb70`.
   - `Thread.tsx`: fires `channels.markRead(channelId)` on every newest-message
     change while the channel is open (not just on select), keyed off the
     message store's newest id for the channel rather than the raw websocket
     event — same effect, avoids a duplicate socket subscription.
   - Quality gates: `yarn tsc --noEmit -p .` clean, `oxlint --type-aware` on
     the changed file clean. No colocated test file for `Thread.tsx` (plan's
     §5 coverage for this segment is the manual click-through below, not a
     unit test — server-side suppression logic itself was already covered by
     `MessageCreatedNotificationsTask.test.ts` in segment 2).
   - **Outstanding**: manual two-user dev click-through (plan §5) — needs a
     human with two real logged-in sessions (DM + group; aggregation count
     grows; suppression while viewing; deep-link; no revival-bump; bell badge
     count). Dev server is already running (`yarn dev`, backend+vite via
     `concurrently`, been up since 2026-09-20) at the dev tunnel host. Not
     something this agent can do unattended without team credentials.
5. **QA deploy → device/panel check → prod deploy** — not started. Needs
   explicit approval per `CLAUDE.local.md` and the standing instruction for
   this task ("no deploys without explicit approval").

## Merge into main (2026-09-25)

`feature/video-calls` (Daily.co calling) and `feature/chat-notifications`
were merged into `main`, in that order, per explicit instruction.

- `main` turned out to already be a strict ancestor of `feature/video-calls`
  (merge-base == main's tip), so that merge (`c3c1e17d1`) was conflict-free —
  effectively fast-forward content, forced to a merge commit with `--no-ff`.
  Gates: `tsc` clean, `lint` 0 errors / 150 warnings, 43/43 touched-file
  tests passed.
- `feature/chat-notifications` (`7cec32a3a`) had two conflicts:
  - `app/scenes/Chat/components/Thread.tsx` — trivial, both sides destructured
    `useStores()` differently (`{ channels, messages }` vs
    `{ callStore, channels, messages }`); kept the video-calls superset.
  - `server/test/factories.ts` — real conflict. Both branches independently
    wrote their own `buildChannel`/`buildChannelMembership` test factories
    (video-calls added them in `68ebdadf3`, chat-notifications reinvented
    them separately in its own history), plus a duplicate
    `import { ChannelType } from "@server/models/Channel"`. Git only flagged
    the `Message` import line as conflicting and silently concatenated the
    two duplicate function pairs elsewhere in the file — not caught as a
    conflict marker, would have been a duplicate-declaration error at
    typecheck time if left in. Resolved by keeping chat-notifications'
    versions (explicit `Promise<T>` return types; its
    `buildChannelMembership` accepts arbitrary overrides via `...overrides`,
    which its own suppression tests need to set `lastReadAt` — video-calls'
    narrower version was a strict subset) and deleting the earlier duplicate
    copies plus the duplicate import.
  - Gates after resolution: `tsc` clean, `lint` 0 errors / 178 warnings (at
    the stated ≤178 ceiling, not over it), 31/31 chat-notification tests
    passed plus a re-run of all 43 video-calls tests (factories.ts is shared
    by both, so both suites were re-verified) — 74/74 total, all green.
- Verified both features present post-merge: `t("Start call")`/`t("Join
  call")` in `Chat.tsx`/`ChannelList.tsx`/`Thread.tsx`, and
  `NotificationEventType.CreateChatMessages` handling in
  `NotificationListItem.tsx` and `Notification.ts`.
- Not pushed — local commits on `main` only, per "no deploys without
  explicit approval." `git push` still needs separate sign-off.

## Decisions already made (do not re-ask)

1. Stale `messageCount` on an open notifications panel is accepted; it
   refreshes on reopen (plan §7 risk 5 — no `notifications.update` emitted
   on the aggregate-update path).
2. Multi-tab suppression (one tab viewing a channel suppresses the
   notification for the whole user) is intended behavior (plan §7 risk 8).

## Side note from this session

On resuming, the working tree had oxfmt-reformatting diffs (pure formatting,
no logic change) across 10 files unrelated to segment 4
(`ChannelDeleteDialog.tsx`, `ChannelLeaveDialog.tsx`, `WebsocketProvider.tsx`,
`MessageContextMenu.tsx`, `ChannelList.tsx`, `NewConversationDialog.tsx`,
`UsersStore.ts`, the schema migration, `ChannelMembership.ts`,
`channels.ts`, `messages.ts`). `yarn format:check` on a clean `HEAD` confirms
these files already fail formatting today (pre-existing debt, not introduced
by this branch) — the diffs looked like a broad `git add` triggering
`lint-staged`'s oxfmt on files outside this segment's scope. Set aside via
`git stash`, then dropped at the user's request (2026-09-25) — not carried
into the merge.

Also untracked and left alone (not part of this feature, no action taken):
`.mcp.json` (local MCP server config), `docs/chat-notifications-plan-prompt.md`
(the plan's source prompt, referenced by the plan doc but never committed),
and a stray `docs/.chat-notifications-plan-prompt.md.swp` (vim swap file).
