import invariant from "invariant";
import { Channel, Team, User } from "@server/models";
import { allow } from "./cancan";
import { and, isTeamAdmin, isTeamModel, or } from "./utils";

/**
 * Any team member may start a channel - unlike Group, which is an
 * admin-managed permission primitive (see server/policies/group.ts),
 * channel creation is intentionally self-service. Guests and viewers are
 * excluded, matching the pattern used for other creation-type abilities
 * (see collection.ts's `createCollection`/`import` abilities).
 */
allow(User, "createChannel", Team, (actor, team) =>
  and(isTeamModel(actor, team), !actor.isGuest, !actor.isViewer)
);

// Calls share the read boundary exactly: any channel member may start, join,
// or end a call. There is deliberately no starter/creator/admin distinction
// on endCall - the client only offers "End" to the last remaining
// participant, and a server-side participant check would cost a provider
// round-trip per end for no real gain among trusted team members.
allow(
  User,
  ["read", "createMessage", "startCall", "endCall"],
  Channel,
  (actor, channel) =>
    and(isTeamModel(actor, channel), isChannelMember(channel, actor.id))
);

// Only the channel creator (or a team admin) can rename/archive - any
// member can read and post.
allow(User, ["update", "archive"], Channel, (actor, channel) =>
  and(
    isTeamModel(actor, channel),
    isChannelMember(channel, actor.id),
    or(isTeamAdmin(actor, channel), actor.id === channel?.createdById)
  )
);

allow(User, "leave", Channel, (actor, channel) =>
  and(isTeamModel(actor, channel), isChannelMember(channel, actor.id))
);

/**
 * Check if the actor is a member of the channel.
 *
 * @param channel The channel to check, with `memberships` preloaded.
 * @param userId The id of the actor to check.
 * @returns The membership id if the actor is a member, false otherwise.
 */
function isChannelMember(channel: Channel | null, userId: string) {
  if (!channel) {
    return false;
  }

  invariant(
    channel.memberships,
    "Development: channel memberships not preloaded, did you forget to include them when fetching the channel?"
  );

  const membership = channel.memberships.find((m) => m.userId === userId);
  return membership ? membership.id : false;
}
