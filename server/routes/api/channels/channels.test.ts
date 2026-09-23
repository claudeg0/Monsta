import { http, HttpResponse } from "msw";
import { v4 as uuidv4 } from "uuid";
import env from "@server/env";
import { Event } from "@server/models";
import { buildChannel, buildUser } from "@server/test/factories";
import { server as mswServer } from "@server/test/msw";
import { getTestServer } from "@server/test/support";

const server = getTestServer();

interface DailyCall {
  method: string;
  path: string;
  body: Record<string, unknown> | null;
}

// Recorded Daily REST calls for the current test. The Channel model graph is
// evaluated by the test setup files before a test file's vi.mock would
// register, so the daily util module can't be mocked directly - Daily is
// mocked at the HTTP layer instead (the same pattern as
// server/utils/embeds.test.ts).
let dailyCalls: DailyCall[];

function mockDailySuccess() {
  mswServer.use(
    http.post("https://api.daily.co/v1/rooms", async ({ request }) => {
      const body = (await request.json()) as Record<string, unknown>;
      dailyCalls.push({ method: "POST", path: "rooms", body });
      return HttpResponse.json({ name: body.name });
    }),
    http.post(
      "https://api.daily.co/v1/meeting-tokens",
      async ({ request }) => {
        dailyCalls.push({
          method: "POST",
          path: "meeting-tokens",
          body: (await request.json()) as Record<string, unknown>,
        });
        return HttpResponse.json({ token: "test-meeting-token" });
      }
    ),
    http.delete("https://api.daily.co/v1/rooms/:name", ({ params }) => {
      dailyCalls.push({
        method: "DELETE",
        path: `rooms/${String(params.name)}`,
        body: null,
      });
      return HttpResponse.json({ deleted: true });
    })
  );
}

beforeEach(() => {
  dailyCalls = [];
  env.DAILY_API_KEY = "test-daily-api-key";
  env.DAILY_DOMAIN = "test.daily.co";
  mockDailySuccess();
});

afterAll(() => {
  env.DAILY_API_KEY = undefined;
  env.DAILY_DOMAIN = undefined;
});

describe("#channels.startCall", () => {
  it("should require authentication", async () => {
    const res = await server.post("/api/channels.startCall", {
      body: { id: uuidv4() },
    });
    expect(res.status).toEqual(401);
  });

  it("should start a call, returning the presented channel and a session", async () => {
    const user = await buildUser();
    const channel = await buildChannel({
      teamId: user.teamId,
      createdById: user.id,
    });

    const res = await server.post("/api/channels.startCall", user, {
      body: { id: channel.id },
    });
    const body = await res.json();

    expect(res.status).toEqual(200);
    expect(body.data.id).toEqual(channel.id);
    expect(body.data.callId).toBeTruthy();
    expect(body.data.callStartedAt).toBeTruthy();
    expect(body.data.callStartedById).toEqual(user.id);
    expect(body.call.id).toEqual(body.data.callId);
    expect(body.call.url).toEqual(`https://test.daily.co/${body.call.id}`);
    expect(body.call.token).toEqual("test-meeting-token");
    expect(body.policies.length).toEqual(1);

    // The room is created with the call id as its name, and a token minted
    // for the starting user.
    const roomCall = dailyCalls.find((c) => c.path === "rooms");
    expect(roomCall?.body?.name).toEqual(body.call.id);
    const tokenCall = dailyCalls.find((c) => c.path === "meeting-tokens");
    const tokenProperties = tokenCall?.body?.properties as Record<
      string,
      unknown
    >;
    expect(tokenProperties.room_name).toEqual(body.call.id);
    expect(tokenProperties.user_name).toEqual(user.name);
    expect(tokenProperties.user_id).toEqual(user.id);

    await expect(
      Event.count({
        where: { name: "channels.call_started", modelId: channel.id },
      })
    ).resolves.toEqual(1);
  });

  it("should join an active call without creating a second room", async () => {
    const starter = await buildUser();
    const joiner = await buildUser({ teamId: starter.teamId });
    const callId = uuidv4();
    const channel = await buildChannel({
      teamId: starter.teamId,
      createdById: starter.id,
      memberIds: [starter.id, joiner.id],
      callId,
      callStartedAt: new Date(),
      callStartedById: starter.id,
    });

    const res = await server.post("/api/channels.startCall", joiner, {
      body: { id: channel.id },
    });
    const body = await res.json();

    expect(res.status).toEqual(200);
    expect(body.call.id).toEqual(callId);
    expect(body.call.url).toEqual(`https://test.daily.co/${callId}`);
    expect(body.call.token).toEqual("test-meeting-token");
    expect(dailyCalls.some((c) => c.path === "rooms")).toBe(false);

    const tokenCall = dailyCalls.find((c) => c.path === "meeting-tokens");
    const tokenProperties = tokenCall?.body?.properties as Record<
      string,
      unknown
    >;
    expect(tokenProperties.room_name).toEqual(callId);
    expect(tokenProperties.user_id).toEqual(joiner.id);

    // Joining is not a state change - no event, no write.
    await expect(
      Event.count({
        where: { name: "channels.call_started", modelId: channel.id },
      })
    ).resolves.toEqual(0);
  });

  it("should return 403 for a non-member", async () => {
    const user = await buildUser();
    const outsider = await buildUser({ teamId: user.teamId });
    const channel = await buildChannel({
      teamId: user.teamId,
      createdById: user.id,
    });

    const res = await server.post("/api/channels.startCall", outsider, {
      body: { id: channel.id },
    });

    expect(res.status).toEqual(403);
  });

  it("should return 404 for an unknown channel", async () => {
    const user = await buildUser();

    const res = await server.post("/api/channels.startCall", user, {
      body: { id: uuidv4() },
    });

    expect(res.status).toEqual(404);
  });

  it("should return 503 and leave the channel untouched when the provider fails", async () => {
    const user = await buildUser();
    const channel = await buildChannel({
      teamId: user.teamId,
      createdById: user.id,
    });
    mswServer.use(
      http.post("https://api.daily.co/v1/rooms", () =>
        HttpResponse.json({}, { status: 500 })
      )
    );

    const res = await server.post("/api/channels.startCall", user, {
      body: { id: channel.id },
    });

    expect(res.status).toEqual(503);
    await channel.reload();
    expect(channel.callId).toBeNull();
    expect(channel.callStartedAt).toBeNull();
    expect(channel.callStartedById).toBeNull();
    await expect(
      Event.count({
        where: { name: "channels.call_started", modelId: channel.id },
      })
    ).resolves.toEqual(0);
  });
});

describe("#channels.endCall", () => {
  it("should require authentication", async () => {
    const res = await server.post("/api/channels.endCall", {
      body: { id: uuidv4() },
    });
    expect(res.status).toEqual(401);
  });

  it("should allow any member to end the call, not just the starter", async () => {
    const starter = await buildUser();
    const member = await buildUser({ teamId: starter.teamId });
    const callId = uuidv4();
    const channel = await buildChannel({
      teamId: starter.teamId,
      createdById: starter.id,
      memberIds: [starter.id, member.id],
      callId,
      callStartedAt: new Date(),
      callStartedById: starter.id,
    });

    const res = await server.post("/api/channels.endCall", member, {
      body: { id: channel.id },
    });

    expect(res.status).toEqual(200);
    await channel.reload();
    expect(channel.callId).toBeNull();
    expect(channel.callStartedAt).toBeNull();
    expect(channel.callStartedById).toBeNull();
    expect(
      dailyCalls.some((c) => c.method === "DELETE" && c.path === `rooms/${callId}`)
    ).toBe(true);
    await expect(
      Event.count({
        where: { name: "channels.call_ended", modelId: channel.id },
      })
    ).resolves.toEqual(1);
  });

  it("should be an idempotent no-op on an idle channel", async () => {
    const user = await buildUser();
    const channel = await buildChannel({
      teamId: user.teamId,
      createdById: user.id,
    });

    const res = await server.post("/api/channels.endCall", user, {
      body: { id: channel.id },
    });

    expect(res.status).toEqual(200);
    expect(dailyCalls.some((c) => c.method === "DELETE")).toBe(false);
    await expect(
      Event.count({
        where: { name: "channels.call_ended", modelId: channel.id },
      })
    ).resolves.toEqual(0);
  });

  it("should still succeed when the room cannot be deleted", async () => {
    const user = await buildUser();
    const callId = uuidv4();
    const channel = await buildChannel({
      teamId: user.teamId,
      createdById: user.id,
      callId,
      callStartedAt: new Date(),
      callStartedById: user.id,
    });
    mswServer.use(
      http.delete("https://api.daily.co/v1/rooms/:name", () =>
        HttpResponse.json({}, { status: 500 })
      )
    );

    const res = await server.post("/api/channels.endCall", user, {
      body: { id: channel.id },
    });

    expect(res.status).toEqual(200);
    await channel.reload();
    expect(channel.callId).toBeNull();
    await expect(
      Event.count({
        where: { name: "channels.call_ended", modelId: channel.id },
      })
    ).resolves.toEqual(1);
  });
});
