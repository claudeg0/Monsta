import { orderBy } from "es-toolkit/compat";
import { override } from "mobx";
import Message from "~/models/Message";
import type RootStore from "./RootStore";
import Store from "./base/Store";

export default class MessagesStore extends Store<Message> {
  constructor(rootStore: RootStore) {
    super(rootStore, Message);
  }

  /**
   * Returns the messages in a channel, oldest first (the order they read
   * in a conversation) - note this is the inverse of the server's
   * newest-first pagination, which is optimized for "load older" scrolling
   * rather than display order.
   *
   * @param channelId ID of the channel to get messages for
   * @returns Array of messages
   */
  inChannel(channelId: string): Message[] {
    return orderBy(
      this.filter((message: Message) => message.channelId === channelId),
      ["createdAt"],
      ["asc"]
    );
  }

  @override
  get orderedData(): Message[] {
    return orderBy(Array.from(this.data.values()), "createdAt", "asc");
  }
}
