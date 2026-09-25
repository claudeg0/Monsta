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

const DAILY_API_BASE_URL = "https://api.daily.co/v1";

/** Generous ceiling for a Daily REST call; joining never blocks on these. */
const REQUEST_TIMEOUT_MS = 10_000;

const MeetingTokenResponseSchema = z.object({
  token: z.string(),
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
 * @param options the method and optional JSON body
 * @returns the parsed JSON response body
 * @throws VideoProviderError on any failure
 */
async function request(
  path: string,
  options: { method: "POST" | "DELETE"; body?: Record<string, unknown> }
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
    throw VideoProviderError();
  }

  // Daily replies with JSON on success; a body we can't parse is as much a
  // provider failure as a 5xx.
  return response.json().catch(() => {
    throw VideoProviderError();
  });
}
