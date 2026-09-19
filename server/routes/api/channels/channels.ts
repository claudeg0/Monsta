import Router from "koa-router";
import { Op, fn, col } from "sequelize";
import type { Transaction } from "sequelize";
import auth from "@server/middlewares/authentication";
import { transaction } from "@server/middlewares/transaction";
import validate from "@server/middlewares/validate";
import { ValidationError } from "@server/errors";
import { Channel, ChannelMembership, Message, User } from "@server/models";
import { ChannelType } from "@server/models/Channel";
import { authorize } from "@server/policies";
import { presentChannel, presentPolicies } from "@server/presenters";
import type { APIContext } from "@server/types";
import * as T from "./schema";

const router = new Router();

/**
 * Counts each channel's messages the viewer hasn't read yet, in one query
 * rather than one per channel.
 *
 * The viewer's own messages are deliberately excluded: `lastReadAt` only
 * advances when they actually open the channel, so without this, sending a
 * message would leave the channel looking unread to the person who just sent
 * it. A never-read channel (null cursor) counts everything.
 *
 * @param user the viewer
 * @param channels the channels to count for, with memberships loaded
 * @param transaction optional transaction to run within
 * @returns a map of channel id to unread count; absent means zero
 */
async function unreadCountsFor(
  user: User,
  channels: Channel[],
  transaction?: Transaction
): Promise<Map<string, number>> {
  const counts = new Map<string, number>();

  if (channels.length === 0) {
    return counts;
  }

  const conditions = channels.map((channel) => {
    const lastReadAt = channel.memberships?.find(
      (membership) => membership.userId === user.id
    )?.lastReadAt;

    return lastReadAt
      ? { channelId: channel.id, createdAt: { [Op.gt]: lastReadAt } }
      : { channelId: channel.id };
  });

  const rows = (await Message.findAll({
    attributes: ["channelId", [fn("COUNT", col("id")), "count"]],
    where: {
      createdById: { [Op.ne]: user.id },
      [Op.or]: conditions,
    },
    group: ["channelId"],
    raw: true,
    transaction,
  })) as unknown as { channelId: string; count: string }[];

  rows.forEach((row) => counts.set(row.channelId, Number(row.count)));
  return counts;
}

router.post(
  "channels.create",
  auth(),
  validate(T.ChannelsCreateSchema),
  transaction(),
  async (ctx: APIContext<T.ChannelsCreateReq>) => {
    const { type, userIds, name } = ctx.input.body;
    const { user } = ctx.state.auth;
    const { transaction } = ctx.state;

    authorize(user, "createChannel", user.team);

    if (type === ChannelType.DirectMessage && userIds.length !== 1) {
      throw ValidationError(
        "A direct message channel must have exactly one other participant"
      );
    }

    const otherUsers = await User.findAll({
      where: { id: userIds, teamId: user.teamId },
      transaction,
    });
    if (otherUsers.length !== userIds.length) {
      throw ValidationError(
        "One or more users could not be found on this team"
      );
    }

    const memberIds = Array.from(new Set([user.id, ...userIds]));

    // For a DM specifically, reuse the existing channel between the same
    // two people rather than creating a duplicate every time someone opens
    // a new conversation with the same person.
    if (type === ChannelType.DirectMessage) {
      const sortedMemberIds = [...memberIds].sort();
      const candidates = await Channel.scope("withMemberships").findAll({
        where: { teamId: user.teamId, type },
        transaction,
      });
      const match = candidates.find((channel) => {
        const ids = channel.memberships.map((m) => m.userId).sort();
        return (
          ids.length === sortedMemberIds.length &&
          ids.every((id, i) => id === sortedMemberIds[i])
        );
      });

      if (match) {
        const counts = await unreadCountsFor(user, [match], transaction);
        ctx.body = {
          data: presentChannel(match, {
            viewerId: user.id,
            unreadCount: counts.get(match.id) ?? 0,
          }),
          policies: presentPolicies(user, [match]),
        };
        return;
      }
    }

    const channel = await Channel.create(
      {
        teamId: user.teamId,
        type,
        name: type === ChannelType.Group ? (name ?? null) : null,
        createdById: user.id,
      },
      { transaction }
    );

    await ChannelMembership.bulkCreate(
      memberIds.map((userId) => ({ channelId: channel.id, userId })),
      { transaction }
    );

    channel.memberships = await ChannelMembership.findAll({
      where: { channelId: channel.id },
      transaction,
    });
    channel.createdBy = user;

    ctx.body = {
      data: presentChannel(channel, { viewerId: user.id }),
      policies: presentPolicies(user, [channel]),
    };
  }
);

router.post(
  "channels.info",
  auth(),
  validate(T.ChannelsInfoSchema),
  async (ctx: APIContext<T.ChannelsInfoReq>) => {
    const { id } = ctx.input.body;
    const { user } = ctx.state.auth;

    const channel = await Channel.scope("withMemberships").findByPk(id, {
      rejectOnEmpty: true,
    });
    authorize(user, "read", channel);

    const counts = await unreadCountsFor(user, [channel]);

    ctx.body = {
      data: presentChannel(channel, {
        viewerId: user.id,
        unreadCount: counts.get(channel.id) ?? 0,
      }),
      policies: presentPolicies(user, [channel]),
    };
  }
);

router.post(
  "channels.list",
  auth(),
  validate(T.ChannelsListSchema),
  async (ctx: APIContext<T.ChannelsListReq>) => {
    const { user } = ctx.state.auth;

    // Every channel this user belongs to - membership itself is the
    // authorization boundary here, so there's no separate policy check
    // per-channel needed for a list scoped this way.
    const memberships = await ChannelMembership.findAll({
      where: { userId: user.id },
    });
    const channelIds = memberships.map((m) => m.channelId);

    const channels = await Channel.scope("withMemberships").findAll({
      where: { id: channelIds },
      order: [["lastMessageAt", "DESC"]],
    });

    // A conversation the viewer hid stays hidden only until there's something
    // new in it. Comparing against lastMessageAt rather than clearing the flag
    // when messages arrive means no write on the hot path, and no way for a
    // reply to land in a list its recipient has made permanently invisible.
    const hiddenAtByChannel = new Map(
      memberships.map((membership) => [membership.channelId, membership.hiddenAt])
    );
    const visible = channels.filter((channel) => {
      const hiddenAt = hiddenAtByChannel.get(channel.id);
      if (!hiddenAt) {
        return true;
      }
      return !!channel.lastMessageAt && channel.lastMessageAt > hiddenAt;
    });

    const counts = await unreadCountsFor(user, visible);

    ctx.body = {
      data: visible.map((channel) =>
        presentChannel(channel, {
          viewerId: user.id,
          unreadCount: counts.get(channel.id) ?? 0,
        })
      ),
      policies: presentPolicies(user, visible),
    };
  }
);

router.post(
  "channels.markRead",
  auth(),
  validate(T.ChannelsMarkReadSchema),
  transaction(),
  async (ctx: APIContext<T.ChannelsMarkReadReq>) => {
    const { id } = ctx.input.body;
    const { user } = ctx.state.auth;
    const { transaction } = ctx.state;

    const channel = await Channel.scope("withMemberships").findByPk(id, {
      transaction,
      rejectOnEmpty: true,
    });
    authorize(user, "read", channel);

    const membership = channel.memberships.find((m) => m.userId === user.id);
    // authorize(user, "read", channel) already guarantees membership exists
    // (that's what isChannelMember checks), so this is here only to satisfy
    // the type checker, not as a real runtime possibility.
    if (!membership) {
      throw ValidationError("Not a member of this channel");
    }

    membership.lastReadAt = new Date();
    await membership.save({ transaction });

    ctx.body = {
      data: presentChannel(channel, { viewerId: user.id }),
      policies: presentPolicies(user, [channel]),
    };
  }
);

router.post(
  "channels.hide",
  auth(),
  validate(T.ChannelsHideSchema),
  transaction(),
  async (ctx: APIContext<T.ChannelsHideReq>) => {
    const { id } = ctx.input.body;
    const { user } = ctx.state.auth;
    const { transaction } = ctx.state;

    const channel = await Channel.scope("withMemberships").findByPk(id, {
      transaction,
      rejectOnEmpty: true,
    });
    authorize(user, "read", channel);

    const membership = channel.memberships.find((m) => m.userId === user.id);
    // authorize(user, "read", channel) already guarantees membership exists
    // (isChannelMember is what it checks), so this is for the type checker.
    if (!membership) {
      throw ValidationError("Not a member of this channel");
    }

    const now = new Date();
    membership.hiddenAt = now;
    // Advancing the read cursor too, so that if the conversation does come
    // back it returns with a count of what arrived since, rather than
    // re-surfacing everything the user had already dismissed.
    membership.lastReadAt = now;
    await membership.save({ transaction });

    ctx.body = {
      success: true,
    };
  }
);

router.post(
  "channels.addUser",
  auth(),
  validate(T.ChannelsAddUserSchema),
  transaction(),
  async (ctx: APIContext<T.ChannelsAddUserReq>) => {
    const { id, userId } = ctx.input.body;
    const { user } = ctx.state.auth;
    const { transaction } = ctx.state;

    const channel = await Channel.scope("withMemberships").findByPk(id, {
      transaction,
      rejectOnEmpty: true,
    });
    // Membership is the authorization boundary: you can only add people to a
    // conversation you're already in.
    authorize(user, "read", channel);

    // A dm is defined as exactly two participants, and the whole client
    // derives its title and presence from "the other one" - a third member
    // would have no coherent meaning there.
    if (channel.type !== ChannelType.Group) {
      throw ValidationError("Only group conversations can have people added");
    }

    if (channel.memberships.some((m) => m.userId === userId)) {
      throw ValidationError("That person is already in this conversation");
    }

    const invitee = await User.findOne({
      where: { id: userId, teamId: user.teamId, suspendedAt: { [Op.is]: null } },
      transaction,
    });
    if (!invitee) {
      throw ValidationError("That user could not be found on this team");
    }

    await ChannelMembership.createWithCtx(
      ctx,
      { channelId: channel.id, userId },
      { name: "add_user" }
    );

    channel.memberships = await ChannelMembership.findAll({
      where: { channelId: channel.id },
      transaction,
    });

    ctx.body = {
      data: presentChannel(channel, { viewerId: user.id }),
      policies: presentPolicies(user, [channel]),
    };
  }
);

router.post(
  "channels.leave",
  auth(),
  validate(T.ChannelsLeaveSchema),
  transaction(),
  async (ctx: APIContext<T.ChannelsLeaveReq>) => {
    const { id } = ctx.input.body;
    const { user } = ctx.state.auth;
    const { transaction } = ctx.state;

    const channel = await Channel.scope("withMemberships").findByPk(id, {
      transaction,
      rejectOnEmpty: true,
    });
    authorize(user, "read", channel);

    // Leaving a dm would leave a one-person channel that renders as an
    // unknown participant. Hiding it (channels.hide) is the exit there.
    if (channel.type !== ChannelType.Group) {
      throw ValidationError("Only group conversations can be left");
    }

    // Nobody can add themselves back, so the last person out would strand the
    // conversation with no members and no way to reach it again.
    if (channel.memberships.length <= 1) {
      throw ValidationError(
        "You're the only person left here - delete the conversation instead"
      );
    }

    const membership = channel.memberships.find((m) => m.userId === user.id);
    if (!membership) {
      throw ValidationError("Not a member of this channel");
    }

    await membership.destroyWithCtx(ctx, { name: "remove_user" });

    ctx.body = {
      success: true,
    };
  }
);

export default router;
