import { http, HttpResponse } from "msw";
import { Hour } from "@shared/utils/time";
import env from "@server/env";
import { server } from "@server/test/msw";
import {
  createMeetingToken,
  createRoom,
  deleteRoom,
  getRoom,
  isRoomExpired,
  roomHasOngoingMeeting,
  roomUrl,
} from "./daily";

const callId = "6f1c9a2e-3b4d-4e5f-8a0b-1c2d3e4f5a6b";

let capturedRequest: {
  method: string;
  url: string;
  authorization: string | null;
  body: Record<string, unknown> | null;
} | null;

function mockDaily(
  method: "post" | "get" | "delete",
  path: string,
  response: () => Response
) {
  server.use(
    http[method](`https://api.daily.co/v1/${path}`, async ({ request }) => {
      capturedRequest = {
        method: request.method,
        url: request.url,
        authorization: request.headers.get("authorization"),
        body: request.body
          ? ((await request.json()) as Record<string, unknown>)
          : null,
      };
      return response();
    })
  );
}

describe("daily utils", () => {
  beforeEach(() => {
    capturedRequest = null;
    env.DAILY_API_KEY = "test-daily-api-key";
    env.DAILY_DOMAIN = "monsta.daily.co";
  });

  afterAll(() => {
    env.DAILY_API_KEY = undefined;
    env.DAILY_DOMAIN = undefined;
  });

  describe("roomUrl", () => {
    it("should build the room URL from the configured domain", () => {
      expect(roomUrl(callId)).toEqual(`https://monsta.daily.co/${callId}`);
    });

    it("should throw VideoProviderError when the domain is not configured", () => {
      env.DAILY_DOMAIN = undefined;
      expect(() => roomUrl(callId)).toThrow("Video calls are not configured");
    });
  });

  describe("createRoom", () => {
    it("should create a private room named by the call id", async () => {
      mockDaily("post", "rooms", () => HttpResponse.json({ name: callId }));

      const room = await createRoom(callId);

      expect(room).toEqual({
        name: callId,
        url: `https://monsta.daily.co/${callId}`,
      });
      expect(capturedRequest?.method).toEqual("POST");
      expect(capturedRequest?.authorization).toEqual(
        "Bearer test-daily-api-key"
      );

      const body = capturedRequest?.body;
      expect(body?.name).toEqual(callId);
      expect(body?.privacy).toEqual("private");

      const properties = body?.properties as Record<string, unknown>;
      expect(properties.enable_chat).toEqual(false);
      expect(properties.enable_people_ui).toEqual(true);
      expect(properties.max_participants).toEqual(20);
      // exp is a join-backstop ~24h out; eject_at_room_exp must NOT be set,
      // or the call would be hard-capped at creation+24h.
      expect(properties).not.toHaveProperty("eject_at_room_exp");
      expect(properties.exp).toBeGreaterThan(
        Math.floor(Date.now() / 1000) + 23 * 60 * 60
      );
      expect(properties.exp).toBeLessThan(
        Math.floor(Date.now() / 1000) + 25 * 60 * 60
      );
    });

    it("should map a non-2xx response to VideoProviderError", async () => {
      mockDaily("post", "rooms", () =>
        HttpResponse.json({ error: "bad request" }, { status: 400 })
      );

      await expect(createRoom(callId)).rejects.toMatchObject({
        status: 503,
        id: "video_provider_error",
      });
    });

    it("should map a network failure to VideoProviderError", async () => {
      mockDaily("post", "rooms", () => HttpResponse.error());

      await expect(createRoom(callId)).rejects.toMatchObject({
        status: 503,
        id: "video_provider_error",
      });
    });

    it("should not call Daily when the API key is not configured", async () => {
      env.DAILY_API_KEY = undefined;
      mockDaily("post", "rooms", () => HttpResponse.json({ name: callId }));

      await expect(createRoom(callId)).rejects.toMatchObject({
        status: 503,
        id: "video_provider_error",
      });
      expect(capturedRequest).toBeNull();
    });
  });

  describe("createMeetingToken", () => {
    it("should mint a token bound to the room and user", async () => {
      mockDaily("post", "meeting-tokens", () =>
        HttpResponse.json({ token: "test-meeting-token" })
      );

      const token = await createMeetingToken({
        roomName: callId,
        userName: "Test User",
        userId: "user-id-1",
      });

      expect(token).toEqual("test-meeting-token");
      expect(capturedRequest?.method).toEqual("POST");

      const properties = capturedRequest?.body?.properties as Record<
        string,
        unknown
      >;
      expect(properties.room_name).toEqual(callId);
      expect(properties.user_name).toEqual("Test User");
      expect(properties.user_id).toEqual("user-id-1");
      expect(properties.exp).toBeGreaterThan(
        Math.floor(Date.now() / 1000) + 23 * 60 * 60
      );
    });

    it("should map a missing token in the response to VideoProviderError", async () => {
      mockDaily("post", "meeting-tokens", () => HttpResponse.json({}));

      await expect(
        createMeetingToken({
          roomName: callId,
          userName: "Test User",
          userId: "user-id-1",
        })
      ).rejects.toMatchObject({ status: 503, id: "video_provider_error" });
    });

    it("should map a non-2xx response to VideoProviderError", async () => {
      mockDaily("post", "meeting-tokens", () =>
        HttpResponse.json({}, { status: 500 })
      );

      await expect(
        createMeetingToken({
          roomName: callId,
          userName: "Test User",
          userId: "user-id-1",
        })
      ).rejects.toMatchObject({ status: 503, id: "video_provider_error" });
    });
  });

  describe("getRoom", () => {
    it("should return the room with its join expiry when active", async () => {
      const exp = Math.floor(Date.now() / 1000) + Hour.seconds;
      mockDaily("get", `rooms/${callId}`, () =>
        HttpResponse.json({ name: callId, config: { exp } })
      );

      await expect(getRoom(callId)).resolves.toEqual({ name: callId, exp });
      expect(capturedRequest?.method).toEqual("GET");
      expect(capturedRequest?.authorization).toEqual(
        "Bearer test-daily-api-key"
      );
    });

    it("should return an expired room rather than treating it as gone", async () => {
      const exp = Math.floor(Date.now() / 1000) - 60;
      mockDaily("get", `rooms/${callId}`, () =>
        HttpResponse.json({ name: callId, config: { exp } })
      );

      // An expired room still exists (and may host an ongoing meeting), so
      // it must be distinguishable from a deleted one.
      await expect(getRoom(callId)).resolves.toEqual({ name: callId, exp });
    });

    it("should return a room without an expiry as never expiring", async () => {
      mockDaily("get", `rooms/${callId}`, () =>
        HttpResponse.json({ name: callId, config: {} })
      );

      await expect(getRoom(callId)).resolves.toEqual({
        name: callId,
        exp: null,
      });
    });

    it("should return null when the room does not exist", async () => {
      mockDaily("get", `rooms/${callId}`, () =>
        HttpResponse.json({}, { status: 404 })
      );

      await expect(getRoom(callId)).resolves.toBeNull();
    });

    it("should map a 5xx response to VideoProviderError", async () => {
      mockDaily("get", `rooms/${callId}`, () =>
        HttpResponse.json({}, { status: 500 })
      );

      await expect(getRoom(callId)).rejects.toMatchObject({
        status: 503,
        id: "video_provider_error",
      });
    });

    it("should not call Daily when the API key is not configured", async () => {
      env.DAILY_API_KEY = undefined;
      mockDaily("get", `rooms/${callId}`, () =>
        HttpResponse.json({ name: callId, config: {} })
      );

      await expect(getRoom(callId)).rejects.toMatchObject({
        status: 503,
        id: "video_provider_error",
      });
      expect(capturedRequest).toBeNull();
    });
  });

  describe("isRoomExpired", () => {
    it("should be false for a room with no expiry", () => {
      expect(isRoomExpired({ name: callId, exp: null })).toBe(false);
    });

    it("should be false for a room expiring in the future", () => {
      const exp = Math.floor(Date.now() / 1000) + Hour.seconds;
      expect(isRoomExpired({ name: callId, exp })).toBe(false);
    });

    it("should be true for a room past its expiry", () => {
      const exp = Math.floor(Date.now() / 1000) - 1;
      expect(isRoomExpired({ name: callId, exp })).toBe(true);
    });
  });

  describe("roomHasOngoingMeeting", () => {
    it("should return true when an ongoing meeting is reported", async () => {
      mockDaily("get", "meetings", () =>
        HttpResponse.json({
          total_count: 1,
          data: [{ ongoing: true }],
        })
      );

      await expect(roomHasOngoingMeeting(callId)).resolves.toBe(true);
      expect(capturedRequest?.url).toContain(
        `room=${encodeURIComponent(callId)}`
      );
      expect(capturedRequest?.url).toContain("ongoing=true");
    });

    it("should return false when no meetings are reported", async () => {
      mockDaily("get", "meetings", () =>
        HttpResponse.json({ total_count: 0, data: [] })
      );

      await expect(roomHasOngoingMeeting(callId)).resolves.toBe(false);
    });

    it("should return false when the reported meeting has ended", async () => {
      mockDaily("get", "meetings", () =>
        HttpResponse.json({
          total_count: 1,
          data: [{ ongoing: false }],
        })
      );

      await expect(roomHasOngoingMeeting(callId)).resolves.toBe(false);
    });

    it("should map a provider failure to VideoProviderError", async () => {
      mockDaily("get", "meetings", () =>
        HttpResponse.json({}, { status: 500 })
      );

      await expect(roomHasOngoingMeeting(callId)).rejects.toMatchObject({
        status: 503,
        id: "video_provider_error",
      });
    });
  });

  describe("deleteRoom", () => {
    it("should delete the room by name", async () => {
      mockDaily("delete", `rooms/${callId}`, () =>
        HttpResponse.json({ deleted: true })
      );

      await expect(deleteRoom(callId)).resolves.toBeUndefined();
      expect(capturedRequest?.method).toEqual("DELETE");
      expect(capturedRequest?.authorization).toEqual(
        "Bearer test-daily-api-key"
      );
    });

    it("should map a failure to VideoProviderError", async () => {
      mockDaily("delete", `rooms/${callId}`, () =>
        HttpResponse.json({}, { status: 404 })
      );

      await expect(deleteRoom(callId)).rejects.toMatchObject({
        status: 503,
        id: "video_provider_error",
      });
    });
  });
});
