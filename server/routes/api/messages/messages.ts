import Router from "koa-router";
import { v4 as uuidv4 } from "uuid";
import { rateLimiter } from "@server/middlewares/rateLimiter";
import auth from "@server/middlewares/authentication";
import { transaction } from "@server/middlewares/transaction";
import validate from "@server/middlewares/validate";
import { commentParser } from "@server/editor";
import { Channel, Message } from "@server/models";
import { authorize } from "@server/policies";
import { presentMessage, presentPolicies } from "@server/presenters";
import type { APIContext } from "@server/types";
import { RateLimiterStrategy } from "@server/utils/RateLimiter";
import pagination from "../middlewares/pagination";
import * as T from "./schema";

const router = new Router();

router.post(
  "messages.create",
  rateLimiter(RateLimiterStrategy.TwentyFivePerMinute),
  auth(),
  validate(T.MessagesCreateSchema),
  transaction(),
  async (ctx: APIContext<T.MessagesCreateReq>) => {
    const { id, channelId, parentMessageId, text } = ctx.input.body;
    const { user } = ctx.state.auth;
    const { transaction } = ctx.state;

    // Step 1: authorize against the parent channel first - this is the
    // actual privacy boundary (DM/group membership), not the message.
    const channel = await Channel.scope("withMemberships").findByPk(channelId, {
      transaction,
      rejectOnEmpty: true,
    });
    authorize(user, "createMessage", channel);

    const data = text
      ? commentParser.parse(text).toJSON()
      : ctx.input.body.data;
    const messageId = id || uuidv4();

    // Step 2: only after the channel check passes, create the message.
    const message = await Message.createWithCtx(ctx, {
      id: messageId,
      channelId,
      createdById: user.id,
      data,
      parentMessageId,
    });
    message.createdBy = user;

    channel.lastMessageAt = message.createdAt;
    await channel.save({ transaction, hooks: false });

    ctx.body = {
      data: presentMessage(message),
      policies: presentPolicies(user, [message]),
    };
  }
);

router.post(
  "messages.list",
  auth(),
  pagination(),
  validate(T.MessagesListSchema),
  async (ctx: APIContext<T.MessagesListReq>) => {
    const { channelId } = ctx.input.body;
    const { user } = ctx.state.auth;

    // Step 1: channel membership gates read access to every message in it.
    const channel = await Channel.scope("withMemberships").findByPk(channelId, {
      rejectOnEmpty: true,
    });
    authorize(user, "read", channel);

    const where = { channelId };
    const [messages, total] = await Promise.all([
      Message.findAll({
        where,
        // presentMessage() calls presentUser(message.createdBy) - without
        // this include that's undefined for every row here (unlike
        // messages.create, which attaches it manually right after
        // creation) and presentUser() throws on it, 500ing the whole
        // request. Confirmed live, not hypothetical: this exact gap
        // broke messages.list on a fresh page load during testing.
        include: [{ association: "createdBy" }],
        // Newest-first, "load older" pagination - the inverse of comments,
        // which read oldest-first for a document's discussion thread.
        order: [["createdAt", "DESC"]],
        offset: ctx.state.pagination.offset,
        limit: ctx.state.pagination.limit,
      }),
      Message.count({ where }),
    ]);

    ctx.body = {
      pagination: { ...ctx.state.pagination, total },
      data: messages.map(presentMessage),
      policies: presentPolicies(user, messages),
    };
  }
);

router.post(
  "messages.update",
  auth(),
  validate(T.MessagesUpdateSchema),
  transaction(),
  async (ctx: APIContext<T.MessagesUpdateReq>) => {
    const { id, text } = ctx.input.body;
    const { user } = ctx.state.auth;
    const { transaction } = ctx.state;

    const message = await Message.findByPk(id, {
      transaction,
      rejectOnEmpty: true,
      lock: { level: transaction.LOCK.UPDATE, of: Message },
      // Same reason as messages.list - presentMessage() needs this loaded.
      include: [{ association: "createdBy" }],
    });

    // Step 1: still a member of the channel this message lives in.
    const channel = await Channel.scope("withMemberships").findByPk(
      message.channelId,
      { transaction, rejectOnEmpty: true }
    );
    authorize(user, "read", channel);
    // Step 2: author-only (or admin) - see server/policies/message.ts.
    authorize(user, "update", message);

    const data = text
      ? commentParser.parse(text).toJSON()
      : ctx.input.body.data;
    if (data !== undefined) {
      message.data = data;
      message.editedAt = new Date();
    }

    await message.saveWithCtx(ctx);

    ctx.body = {
      data: presentMessage(message),
      policies: presentPolicies(user, [message]),
    };
  }
);

router.post(
  "messages.delete",
  auth(),
  validate(T.MessagesDeleteSchema),
  transaction(),
  async (ctx: APIContext<T.MessagesDeleteReq>) => {
    const { id } = ctx.input.body;
    const { user } = ctx.state.auth;
    const { transaction } = ctx.state;

    const message = await Message.findByPk(id, {
      transaction,
      rejectOnEmpty: true,
      lock: { level: transaction.LOCK.UPDATE, of: Message },
      // Load-bearing for authorization, not presentation (nothing is
      // presented here): policies/message.ts gates on
      // isTeamModel(actor, message.createdBy), which returns false for an
      // unloaded association. Without this the and() short-circuits before
      // the admin/author check is ever reached and delete is refused for
      // everyone - including the author and admins.
      include: [{ association: "createdBy" }],
    });

    const channel = await Channel.scope("withMemberships").findByPk(
      message.channelId,
      { transaction, rejectOnEmpty: true }
    );
    authorize(user, "read", channel);
    authorize(user, "delete", message);

    await message.destroyWithCtx(ctx);

    ctx.body = {
      success: true,
    };
  }
);

export default router;
