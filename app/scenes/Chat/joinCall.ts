import { toast } from "sonner";
import { errToString } from "@shared/utils/error";
import type CallStore from "~/stores/CallStore";
import type ChannelsStore from "~/stores/ChannelsStore";

/**
 * Starts a call in a channel, or joins the one already running there, and
 * opens the overlay - shared by every place that can trigger this: the Chat
 * header button, the channel list's active-call indicator, the in-thread
 * banner, and the "Join" action on the call-started toast. All four want
 * the same two steps and the same error handling, so this is one place
 * rather than four.
 *
 * @param stores channels and callStore from the root store
 * @param channelId ID of the channel to start or join a call in
 */
export async function joinCall(
  stores: { channels: ChannelsStore; callStore: CallStore },
  channelId: string
): Promise<void> {
  try {
    const { call } = await stores.channels.startCall(channelId);
    stores.callStore.open(channelId, call);
  } catch (err) {
    toast.error(errToString(err));
  }
}
