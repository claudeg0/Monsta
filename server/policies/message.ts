import { Message, User } from "@server/models";
import { allow } from "./cancan";
import { and, isTeamModel, or } from "./utils";

// IMPORTANT: these abilities only check team membership of the message's
// author, exactly mirroring Comment's policy (server/policies/comment.ts) -
// they are necessary but NOT sufficient for read access on their own.
// Channel membership (a message's actual privacy boundary - this is what
// keeps a DM private) is enforced separately by authorizing "read" on the
// parent Channel first, the same two-step pattern comments.info uses for
// comment + parent document (server/routes/api/comments/comments.ts).
// Every messages.* route handler MUST authorize the channel before
// returning or accepting a message, not rely on this policy alone.

allow(User, "read", Message, (actor, message) =>
  isTeamModel(actor, message?.createdBy)
);

allow(User, ["update", "delete"], Message, (actor, message) =>
  and(
    isTeamModel(actor, message?.createdBy),
    or(actor.isAdmin, actor.id === message?.createdById)
  )
);
