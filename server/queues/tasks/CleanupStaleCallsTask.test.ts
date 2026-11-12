import { subHours, subMinutes } from "date-fns";
import { http, HttpResponse } from "msw";
import { v4 as uuidv4 } from "uuid";
import { Hour } from "@shared/utils/time";
import env from "@server/env";
import { Event } from "@server/models";
import { buildChannel, buildUser } from "@server/test/factories";
import { server as mswServer } from "@server/test/msw";
import CleanupStaleCallsTask from "./CleanupStaleCallsTask";

const props = {
  limit: 100,
  partition: {
    partitionIndex: 0,
    partitionCount: 1,
  },
};

interface DailyCall {
  method: string;
  path: string;
}

// Recorded Daily REST calls for the current test - Daily is mocked at the
// HTTP layer (the same pattern as channels.test.ts).
let dailyCalls: DailyCall[];

function mockRoom({ exp }: { exp: number }) {
  mswServer.use(
    http.get("https://api.daily.co/v1/rooms/:name", ({ params }) => {
      const name = String(params.name);
      dailyCalls.push({ method: "GET", path: `rooms/${name}` });
      return HttpResponse.json({ name, config: { exp } });
    })
  );
}

function mockRoomNotFound() {
  mswServer.use(
    http.get("https://api.daily.co/v1/rooms/:name", ({ params }) => {
      dailyCalls.push({
        method: "GET",
        path: `rooms/${String(params.name)}`,
      });
      return HttpResponse.json({}, { status: 404 });
    })
  );
}

function mockMeetings(ongoing: boolean) {
  mswServer.use(
    http.get("https://api.daily.co/v1/meetings", () => {
      dailyCalls.push({ method: "GET", path: "meetings" });
      return HttpResponse.json({
        total_count: ongoing ? 1 : 0,
        data: ongoing ? [{ ongoing: true }] : [],
      });
    })
  );
}

beforeEach(() => {
  dailyCalls = [];
  env.DAILY_API_KEY = "test-daily-api-key";
  mswServer.use(
    http.delete("https://api.daily.co/v1/rooms/:name", ({ params }) => {
      dailyCalls.push({
        method: "DELETE",
        path: `rooms/${String(params.name)}`,
      });
      return HttpResponse.json({ deleted: true });
    })
  );
  // Defaults: an extant, joinable room with no ongoing meeting. Individual
  // tests override the room lookup (404 / expired) or the meetings answer.
  mockRoom({ exp: Math.floor(Date.now() / 1000) + Hour.seconds });
  mockMeetings(false);
});

afterAll(() => {
  env.DAILY_API_KEY = undefined;
});

async function buildStaleChannel() {
  const user = await buildUser();
  const callId = uuidv4();
  const channel = await buildChannel({
    teamId: user.teamId,
    createdById: user.id,
    callId,
    callStartedAt: subHours(new Date(), 2),
    callStartedById: user.id,
  });
  return { channel, callId };
}

describe("CleanupStaleCallsTask", () => {
  it("should end a call whose room no longer exists at Daily", async () => {
    const { channel, callId } = await buildStaleChannel();
    mockRoomNotFound();

    await new CleanupStaleCallsTask().perform(props);

    await channel.reload();
    expect(channel.callId).toBeNull();
    expect(channel.callStartedAt).toBeNull();
    expect(channel.callStartedById).toBeNull();
    expect(
      dailyCalls.some(
        (c) => c.method === "DELETE" && c.path === `rooms/${callId}`
      )
    ).toBe(true);
    await expect(
      Event.count({
        where: { name: "channels.call_ended", modelId: channel.id },
      })
    ).resolves.toEqual(1);
  });

  it("should end an expired room's call when no meeting is ongoing", async () => {
    const { channel } = await buildStaleChannel();
    mockRoom({ exp: Math.floor(Date.now() / 1000) - 60 });

    await new CleanupStaleCallsTask().perform(props);

    await channel.reload();
    expect(channel.callId).toBeNull();
  });

  it("should end a call whose room is joinable but has no ongoing meeting", async () => {
    // The "nobody ever joined / webhook missed" case - a joinable room with
    // nobody on it is still a dead call once an hour has passed.
    const { channel } = await buildStaleChannel();

    await new CleanupStaleCallsTask().perform(props);

    await channel.reload();
    expect(channel.callId).toBeNull();
  });

  it("should not end a call with an ongoing meeting", async () => {
    const { channel, callId } = await buildStaleChannel();
    mockMeetings(true);

    await new CleanupStaleCallsTask().perform(props);

    await channel.reload();
    expect(channel.callId).toEqual(callId);
    expect(dailyCalls.some((c) => c.method === "DELETE")).toBe(false);
    await expect(
      Event.count({
        where: { name: "channels.call_ended", modelId: channel.id },
      })
    ).resolves.toEqual(0);
  });

  it("should not touch calls started less than an hour ago", async () => {
    const user = await buildUser();
    const callId = uuidv4();
    const channel = await buildChannel({
      teamId: user.teamId,
      createdById: user.id,
      callId,
      callStartedAt: subMinutes(new Date(), 59),
      callStartedById: user.id,
    });

    await new CleanupStaleCallsTask().perform(props);

    await channel.reload();
    expect(channel.callId).toEqual(callId);
    // Channels built by earlier tests may still be swept, but this channel's
    // room must never be looked up at all.
    expect(dailyCalls.some((c) => c.path === `rooms/${callId}`)).toBe(false);
  });

  it("should not end a call when the room lookup fails", async () => {
    const { channel, callId } = await buildStaleChannel();
    mswServer.use(
      http.get("https://api.daily.co/v1/rooms/:name", () =>
        HttpResponse.json({}, { status: 500 })
      )
    );

    await new CleanupStaleCallsTask().perform(props);

    // "Unknown" is not "stale" - a provider failure must never clear a call.
    await channel.reload();
    expect(channel.callId).toEqual(callId);
    expect(dailyCalls.some((c) => c.method === "DELETE")).toBe(false);
  });

  it("should not end a call when the meetings lookup fails", async () => {
    const { channel, callId } = await buildStaleChannel();
    mswServer.use(
      http.get("https://api.daily.co/v1/meetings", () =>
        HttpResponse.json({}, { status: 500 })
      )
    );

    await new CleanupStaleCallsTask().perform(props);

    await channel.reload();
    expect(channel.callId).toEqual(callId);
    expect(dailyCalls.some((c) => c.method === "DELETE")).toBe(false);
  });

  it("should do nothing when Daily is not configured", async () => {
    env.DAILY_API_KEY = undefined;
    const { channel, callId } = await buildStaleChannel();

    await new CleanupStaleCallsTask().perform(props);

    await channel.reload();
    expect(channel.callId).toEqual(callId);
    expect(dailyCalls).toEqual([]);
  });
});
