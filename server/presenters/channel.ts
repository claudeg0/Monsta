import type { Channel } from "@server/models";
import presentUser from "./user";

type Options = {
  /** The id of the user this response is being presented to - used to
   * surface their own unread-read cursor for this channel. Omit only when
   * presenting a channel with no specific viewer in mind (there is no such
   * case in the current routes; every one has an authenticated actor). */
  viewerId?: string;
  /** How many messages the viewer hasn't read here. Like the read cursor
   * this is per-viewer, not shared state. Defaults to 0 rather than being
   * computed here, since counting is a query the caller batches across every
   * channel at once (see routes/api/channels/channels.ts). */
  unreadCount?: number;
};

export default function present(
  channel: Channel,
  { viewerId, unreadCount = 0 }: Options = {}
) {
  const viewerMembership = viewerId
    ? channel.memberships?.find((m) => m.userId === viewerId)
    : undefined;

  return {
    id: channel.id,
    teamId: channel.teamId,
    type: channel.type,
    name: channel.name,
    createdBy: channel.createdBy ? presentUser(channel.createdBy) : undefined,
    createdById: channel.createdById,
    memberIds: channel.memberships?.map((m) => m.userId) ?? [],
    lastMessageAt: channel.lastMessageAt,
    archivedAt: channel.archivedAt,
    createdAt: channel.createdAt,
    updatedAt: channel.updatedAt,
    // The viewer's own read cursor - unread state is `lastMessageAt >
    // currentUserLastReadAt` (or lastMessageAt present at all with a null
    // cursor, i.e. never read). Undefined only if this channel was somehow
    // presented without a viewer or without memberships loaded - neither
    // happens via the current routes, but this isn't asserted since a
    // presenter shouldn't throw on missing optional context.
    currentUserLastReadAt: viewerMembership?.lastReadAt ?? null,
    unreadCount,
  };
}
