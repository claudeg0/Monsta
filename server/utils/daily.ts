import { z } from "zod";
import { Day } from "@shared/utils/time";
import env from "@server/env";
import { VideoProviderError } from "@server/errors";

/**
 * The provider-agnostic handle a client needs to join a call: which room,
 * where, and proof they may enter. Returned by `Channel.startCall` and
 * surfaced as `call` in the `channels.startCall` response - keeping this
 * shape provider-neutral is what confines Daily to this file.
 */
export interface CallSession {
  /** The call id, which is also the Daily room name. */
  id: string;
  /** The full room URL the daily-js frame joins. */
  url: string;
  /** A meeting token authenticating this specific user to the room. */
  token: string;
}

/**
 * The parts of a Daily room this codebase cares about, as returned by
 * `getRoom`.
 */
export interface DailyRoom {
  /** The room name (equal to the call's id). */
  name: string;
  /**
   * Epoch seconds after which the room refuses new joins, null when the
   * room has no expiry. This never ejects participants already in a
   * meeting - see `createRoom`.
   */
  exp: number | null;
}

const DAILY_API_BASE_URL = "https://api.daily.co/v1";

/** Generous ceiling for a Daily REST call; joining never blocks on these. */
const REQUEST_TIMEOUT_MS = 10_000;

const MeetingTokenResponseSchema = z.object({
  token: z.string(),
});

const RoomResponseSchema = z.object({
  name: z.string(),
  // Room properties set at creation (see createRoom) are echoed back under
  // `config` - exp included when one was set.
  config: z
    .object({
      exp: z.number().nullish(),
    })
    .nullish(),
});

const MeetingsResponseSchema = z.object({
  total_count: z.number(),
  data: z.array(
    z.object({
      ongoing: z.boolean(),
    })
  ),
});

/**
 * Builds the join URL for a room.
 *
 * @param roomName the room name (equal to the call's id)
 * @returns the full room URL on the configured Daily domain
 */
export function roomUrl(roomName: string): string {
  if (!env.DAILY_DOMAIN) {
    throw VideoProviderError("Video calls are not configured");
  }
  return `https://${env.DAILY_DOMAIN}/${roomName}`;
}

/**
 * Creates a private Daily room for a call. The room expires 24h after
 * creation as a join-backstop for abandoned rooms only: `eject_at_room_exp`
 * is deliberately NOT set, so an ongoing call is never cut off - `exp`
 * merely refuses new joins to stale rooms.
 *
 * @param callId the call id, used as the (unguessable) room name
 * @returns the room name and its join URL
 * @throws VideoProviderError if the room could not be created
 */
export async function createRoom(
  callId: string
): Promise<{ name: string; url: string }> {
  await request("rooms", {
    method: "POST",
    body: {
      name: callId,
      privacy: "private",
      properties: {
        exp: Math.floor(Date.now() / 1000) + Day.seconds,
        // Monsta's own chat is the chat - Daily's is disabled.
        enable_chat: false,
        enable_people_ui: true,
        max_participants: 20,
      },
    },
  });

  return { name: callId, url: roomUrl(callId) };
}

/**
 * Fetches a room from Daily so its liveness can be verified before joining
 * or cleaning up a call that references it.
 *
 * @param roomName the room name (equal to the call's id)
 * @returns the room, or null when Daily answers 404 - the room does not
 * exist (deleted, or expired and garbage-collected)
 * @throws VideoProviderError on any other failure - network, 5xx, an
 * unparseable body, or the API key not being configured. Callers must
 * treat this as "unknown", never as "stale"
 */
export async function getRoom(roomName: string): Promise<DailyRoom | null> {
  const data = await request(`rooms/${roomName}`, {
    method: "GET",
    allowNotFound: true,
  });
  if (data === null) {
    return null;
  }

  const parsed = RoomResponseSchema.safeParse(data);
  if (!parsed.success) {
    throw VideoProviderError();
  }
  return { name: parsed.data.name, exp: parsed.data.config?.exp ?? null };
}

/**
 * Whether a room's join-backstop expiry has passed. An expired room
 * refuses new joins but does not eject participants already in a meeting,
 * so an expired room may still host an ongoing call.
 *
 * @param room the room to check
 * @returns whether the room no longer accepts new joins
 */
export function isRoomExpired(room: DailyRoom): boolean {
  return room.exp !== null && room.exp <= Math.floor(Date.now() / 1000);
}

/**
 * Mints a meeting token binding a user to a room. A fresh token is minted on
 * every join; each is valid for 24h from minting, so token expiry mid-call is
 * not a scenario.
 *
 * @param roomName the room the token grants access to
 * @param userName the participant's display name in the call
 * @param userId the participant's user id
 * @returns the meeting token
 * @throws VideoProviderError if the token could not be minted
 */
export async function createMeetingToken({
  roomName,
  userName,
  userId,
}: {
  roomName: string;
  userName: string;
  userId: string;
}): Promise<string> {
  const data = await request("meeting-tokens", {
    method: "POST",
    body: {
      properties: {
        room_name: roomName,
        user_name: userName,
        user_id: userId,
        exp: Math.floor(Date.now() / 1000) + Day.seconds,
      },
    },
  });

  const parsed = MeetingTokenResponseSchema.safeParse(data);
  if (!parsed.success) {
    throw VideoProviderError();
  }
  return parsed.data.token;
}

/**
 * Whether Daily reports an in-progress meeting in the room - i.e. someone
 * is actually on the call right now.
 *
 * @param roomName the room name (equal to the call's id)
 * @throws VideoProviderError on any failure - callers must treat this as
 * "unknown", never as "no meeting"
 */
export async function roomHasOngoingMeeting(
  roomName: string
): Promise<boolean> {
  const data = await request(
    `meetings?room=${encodeURIComponent(roomName)}&ongoing=true`,
    { method: "GET" }
  );

  const parsed = MeetingsResponseSchema.safeParse(data);
  if (!parsed.success) {
    throw VideoProviderError();
  }
  // The query already filters to ongoing meetings; checking the flag again
  // keeps the answer correct even if that filter were ever ignored.
  return parsed.data.data.some((meeting) => meeting.ongoing);
}

/**
 * Deletes a Daily room, kicking any remaining participants.
 *
 * @param roomName the room name (equal to the call's id)
 * @throws VideoProviderError if the room could not be deleted - callers are
 * expected to treat deletion as best-effort and only log this
 */
export async function deleteRoom(roomName: string): Promise<void> {
  await request(`rooms/${roomName}`, { method: "DELETE" });
}

/**
 * Performs an authenticated request against the Daily REST API, mapping any
 * failure - network, non-2xx, unexpected body - to a 503 VideoProviderError
 * so routes never leak provider internals.
 *
 * @param path the API path relative to the Daily v1 base URL
 * @param options the method, optional JSON body, and whether a 404 should
 * resolve to null rather than throw (room lookups, where "room is gone" is
 * an answer rather than an error)
 * @returns the parsed JSON response body, or null on a tolerated 404
 * @throws VideoProviderError on any other failure
 */
async function request(
  path: string,
  options: {
    method: "GET" | "POST" | "DELETE";
    body?: Record<string, unknown>;
    allowNotFound?: boolean;
  }
): Promise<unknown> {
  if (!env.DAILY_API_KEY) {
    throw VideoProviderError("Video calls are not configured");
  }

  let response: Response;
  try {
    response = await fetch(`${DAILY_API_BASE_URL}/${path}`, {
      method: options.method,
      headers: {
        Authorization: `Bearer ${env.DAILY_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: options.body ? JSON.stringify(options.body) : undefined,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (_err) {
    throw VideoProviderError();
  }

  if (!response.ok) {
    if (options.allowNotFound && response.status === 404) {
      return null;
    }
    throw VideoProviderError();
  }

  // Daily replies with JSON on success; a body we can't parse is as much a
  // provider failure as a 5xx.
  return response.json().catch(() => {
    throw VideoProviderError();
  });
}
