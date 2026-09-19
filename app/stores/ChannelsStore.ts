import invariant from "invariant";
import { orderBy } from "es-toolkit/compat";
import { action, override } from "mobx";
import Channel from "~/models/Channel";
import { client } from "~/utils/ApiClient";
import type RootStore from "./RootStore";
import Store from "./base/Store";

export default class ChannelsStore extends Store<Channel> {
  constructor(rootStore: RootStore) {
    super(rootStore, Channel);
  }

  /**
   * Mark a channel as read up to its most recent message, advancing the
   * current user's own read cursor.
   *
   * @param id ID of the channel to mark read
   */
  @action
  markRead = async (id: string): Promise<Channel> => {
    const res = await client.post("/channels.markRead", { id });
    invariant(res?.data, "Channel not available");
    this.addPolicies(res.policies);
    this.add(res.data);
    return this.data.get(res.data.id) as Channel;
  };

  /**
   * Hide a conversation from the current user's own list. Nothing is deleted
   * and nobody else's list changes - and it returns by itself if a new
   * message arrives (see routes/api/channels/channels.ts). Removed from the
   * store here so the rail updates without waiting for a refetch.
   *
   * @param id ID of the channel to hide
   */
  @action
  hide = async (id: string): Promise<void> => {
    await client.post("/channels.hide", { id });
    this.remove(id);
  };

  /**
   * Add a team member to a group conversation. Groups only - a dm is defined
   * as exactly two people.
   *
   * @param id ID of the channel
   * @param userId ID of the person to add
   */
  @action
  addUser = async (id: string, userId: string): Promise<Channel> => {
    const res = await client.post("/channels.addUser", { id, userId });
    invariant(res?.data, "Channel not available");
    this.addPolicies(res.policies);
    this.add(res.data);
    return this.data.get(res.data.id) as Channel;
  };

  /**
   * Leave a group conversation. Nobody can add themselves back, so this is
   * one-way until someone still inside adds them again.
   *
   * @param id ID of the channel to leave
   */
  @action
  leave = async (id: string): Promise<void> => {
    await client.post("/channels.leave", { id });
    this.remove(id);
  };

  /**
   * Returns the channels the current user belongs to, most recently active
   * first - the natural order for a channel list / inbox.
   */
  @override
  get orderedData(): Channel[] {
    return orderBy(
      Array.from(this.data.values()),
      [(channel) => channel.lastMessageAt ?? channel.createdAt],
      ["desc"]
    );
  }
}
