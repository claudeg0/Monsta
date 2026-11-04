Create an implementation plan (markdown, saved to /opt/Monsta/docs/chat-notifications-plan.md) for unified chat notifications in Monsta, based on the design memo at /opt/Monsta/docs/monsta-chat-notifications-memo.md (read it first — it maps the codebase).

GOAL: Chat DMs/mentions appear in the existing global notifications panel (hamburger menu), one notification per channel, aggregated across messages, suppressed when the user has already read up to the latest message in that channel.

PRODUCT RULES (from the user, non-negotiable):
1. ONE notification row per (user, channel). New messages update the existing unread row: increment a messageCount in the data JSONB, update the snippet/actor info, but DO NOT re-sort it to the top of the notifications list (no revival bumping).
2. SUPPRESS when the user read cursor for that channel is current (lastMessageViewedAt >= newest message createdAt at task-execution time). This replaces "user is viewing" presence — no new presence plumbing.
3. NO email for chat notifications. Explicitly exclude NotificationChannelType.Email for the new event type.
4. Deep-link: clicking the notification in the global panel opens the chat channel.

TECHNICAL DIRECTION (from the memo, follow unless you find a concrete reason not to):
- New NotificationEventType (e.g. CreateChatMessages) in shared/types.ts
- Add nullable channelId FK to notifications table (migration)
- Subscribe messages.create in NotificationsProcessor.applicableEvents
- Aggregation: reuse the ReactionCreatedNotificationsTask row-reuse pattern
- Suppression: read-cursor check inside the task at execution time (both create AND update paths)
- Rendering: extend the notifications list to carry channelId; client renders a chat-specific row with channel name + message count, deep-links to the channel

RISK MITIGATIONS the plan must address explicitly:
- Risk 1 (schema bias): verify notifications.list query and default scope work when documentId/commentId are null but channelId is set. Note any eager-loading assumptions. The plan must include a test proving a channel-only notification renders in the list.
- Risk 4 (markRead race): the read-cursor guard described above, on both create and update paths. Include a test simulating: message created → user reads immediately → task executes → no notification created.
- Risk 2 (revival noise): confirm the update path does not touch createdAt or re-order the list.
- Risk 5: explicitly disable the email channel for this event type.

PLAN STRUCTURE (mirror the video-calling plan rigor):
1. Summary & decisions (including the 4 product rules above)
2. Data model & migration (channelId column, indexes — including a composite index on (userId, channelId, viewedAt) for the aggregation lookup)
3. Server changes file-by-file (event type, processor subscription, task logic with pseudocode for create-vs-update-vs-skip)
4. Client changes file-by-file (notification row rendering, deep-link, mark-read flow)
5. Testing plan (unit tests for aggregation, suppression, no-email; integration test for list rendering with null documentId)
6. Build order (segments with commit checkpoints, same discipline as the video build)
7. Risks & open questions

Do NOT write implementation code. Output the plan file only, then stop.
