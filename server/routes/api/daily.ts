import crypto from "node:crypto";
import Router from "koa-router";
import { z } from "zod";
import { createContext } from "@server/context";
import env from "@server/env";
import { InvalidRequestError, NotFoundError } from "@server/errors";
import Logger from "@server/logging/Logger";
import { transaction } from "@server/middlewares/transaction";
import { Channel } from "@server/models";
import type { APIContext } from "@server/types";
import { safeEqual } from "@server/utils/crypto";

const router = new Router();

// Only the fields the handler acts on - Daily payloads carry much more, and
// the {"test": "test"} verification request it sends when a webhook is
// registered has neither field, so everything here is optional.
const DailyWebhookEventSchema = z.object({
  type: z.string().optional(),
  payload: z
    .object({
      room: z.string().optional(),
    })
    .optional(),
});

/**
 * Returns the value of a single-valued request header.
 *
 * @param ctx the request context
 * @param name the lowercase header name
 * @returns the header value, or undefined if absent or multi-valued
 */
function header(ctx: APIContext, name: string): string | undefined {
  const value = ctx.request.headers[name];
  return Array.isArray(value) ? value[0] : value;
}

router.post("daily.webhook", transaction(), async (ctx: APIContext) => {
  const { transaction } = ctx.state;

  // The endpoint is inactive unless a webhook secret is configured.
  if (!env.DAILY_WEBHOOK_SECRET) {
    throw NotFoundError();
  }

  // Daily signs `<X-Webhook-Timestamp>.<JSON.stringify(body)>` with
  // HMAC-SHA256 keyed by the base64-decoded webhook `hmac` secret, and
  // sends the base64 digest in X-Webhook-Signature (see
  // https://docs.daily.co/reference/rest-api/webhooks). Daily's own
  // verification snippet re-serializes the parsed JSON body rather than
  // reading raw bytes, so doing the same here matches exactly - the same
  // approach as server/middlewares/validateWebhook.ts.
  const signature = header(ctx, "x-webhook-signature");
  const timestamp = header(ctx, "x-webhook-timestamp");
  const computed = crypto
    .createHmac("sha256", Buffer.from(env.DAILY_WEBHOOK_SECRET, "base64"))
    .update(`${timestamp}.${JSON.stringify(ctx.request.body)}`)
    .digest("base64");

  if (!signature || !timestamp || !safeEqual(computed, signature)) {
    Logger.warn("Rejected Daily webhook with invalid signature");
    throw InvalidRequestError("Invalid webhook signature");
  }

  const parsed = DailyWebhookEventSchema.safeParse(ctx.request.body);
  const room = parsed.success ? parsed.data.payload?.room : undefined;

  if (!parsed.success || parsed.data.type !== "meeting.ended" || !room) {
    ctx.body = { success: true };
    return;
  }

  // The room name is the channel's callId. If nothing matches, the call
  // was already ended through the normal route or this is a replayed /
  // unknown delivery - either way it's a no-op.
  const channel = await Channel.findOne({
    where: { callId: room },
    transaction,
  });
  if (!channel) {
    Logger.debug("http", "Daily webhook for unknown or ended room", {
      room,
    });
    ctx.body = { success: true };
    return;
  }

  await channel.endCall(createContext({ transaction, ip: ctx.request.ip }));

  ctx.body = { success: true };
});

export default router;
