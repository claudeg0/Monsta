import crypto from "node:crypto";
import { v4 as uuidv4 } from "uuid";
import env from "@server/env";
import { Channel } from "@server/models";
import { buildChannel, buildUser } from "@server/test/factories";
import { getTestServer } from "@server/test/support";

const server = getTestServer();

const webhookSecret = Buffer.from("test-daily-webhook-secret").toString(
  "base64"
);

function sign(body: unknown, timestamp: string): string {
  return crypto
    .createHmac("sha256", Buffer.from(webhookSecret, "base64"))
    .update(`${timestamp}.${JSON.stringify(body)}`)
    .digest("base64");
}

async function postWebhook(body: unknown) {
  const timestamp = String(Math.floor(Date.now() / 1000));
  return server.post("/api/daily.webhook", {
    body,
    headers: {
      "x-webhook-signature": sign(body, timestamp),
      "x-webhook-timestamp": timestamp,
    },
  });
}

describe("#daily.webhook", () => {
  beforeEach(() => {
    env.DAILY_WEBHOOK_SECRET = webhookSecret;
  });

  afterAll(() => {
    env.DAILY_WEBHOOK_SECRET = undefined;
  });

  it("should return 404 when the webhook secret is not configured", async () => {
    env.DAILY_WEBHOOK_SECRET = undefined;

    const res = await postWebhook({
      type: "meeting.ended",
      payload: { room: uuidv4() },
    });

    expect(res.status).toEqual(404);
  });

  it("should reject a request with no signature headers", async () => {
    const res = await server.post("/api/daily.webhook", {
      body: { type: "meeting.ended", payload: { room: uuidv4() } },
    });

    expect(res.status).toEqual(400);
  });

  it("should reject a request with an incorrect signature", async () => {
    const res = await server.post("/api/daily.webhook", {
      body: { type: "meeting.ended", payload: { room: uuidv4() } },
      headers: {
        "x-webhook-signature": "not-the-right-signature",
        "x-webhook-timestamp": String(Math.floor(Date.now() / 1000)),
      },
    });

    expect(res.status).toEqual(400);
  });

  it("should end the call for the channel whose callId matches the room", async () => {
    const user = await buildUser();
    const callId = uuidv4();
    const channel = await buildChannel({
      teamId: user.teamId,
      createdById: user.id,
      callId,
      callStartedAt: new Date(),
      callStartedById: user.id,
    });

    const res = await postWebhook({
      type: "meeting.ended",
      payload: { room: callId },
    });

    expect(res.status).toEqual(200);
    await channel.reload();
    expect(channel.callId).toBeNull();
    expect(channel.callStartedAt).toBeNull();
    expect(channel.callStartedById).toBeNull();
  });

  it("should be a no-op for a room that matches no channel", async () => {
    const res = await postWebhook({
      type: "meeting.ended",
      payload: { room: uuidv4() },
    });

    expect(res.status).toEqual(200);
  });

  it("should be a no-op for an event type other than meeting.ended", async () => {
    const user = await buildUser();
    const callId = uuidv4();
    const channel = await buildChannel({
      teamId: user.teamId,
      createdById: user.id,
      callId,
      callStartedAt: new Date(),
      callStartedById: user.id,
    });

    // The connectivity check Daily sends when a webhook is first registered.
    const res = await postWebhook({ test: "test" });

    expect(res.status).toEqual(200);
    await channel.reload();
    expect(channel.callId).toEqual(callId);
  });

  it("should be idempotent for a room already cleared", async () => {
    const callId = uuidv4();

    const first = await postWebhook({
      type: "meeting.ended",
      payload: { room: callId },
    });
    const second = await postWebhook({
      type: "meeting.ended",
      payload: { room: callId },
    });

    expect(first.status).toEqual(200);
    expect(second.status).toEqual(200);
    await expect(Channel.count({ where: { callId } })).resolves.toEqual(0);
  });
});
