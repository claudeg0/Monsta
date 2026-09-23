import { observable } from "mobx";
import User from "~/models/User";
import Model from "./base/Model";
import Field from "./decorators/Field";
import Relation from "./decorators/Relation";

export enum ChannelType {
  DirectMessage = "dm",
  Group = "group",
}

class Channel extends Model {
  static modelName = "Channel";

  constructor(fields: Record<string, unknown>, store: Model["store"]) {
    super(fields, store);
    this.initialize(fields);
  }

  @Field
  @observable
  type: ChannelType;

  /**
   * Display name - always null for a `dm` channel, the client derives a
   * display name from the other participant. Optional for `group`.
   */
  @Field
  @observable
  name: string | null;

  @Field
  @observable
  memberIds: string[];

  @Relation(() => User)
  createdBy: User;

  createdById: string;

  @Field
  @observable
  lastMessageAt: string | null;

  @Field
  @observable
  archivedAt: string | null;

  /**
   * The current user's own read cursor for this channel - null means never
   * read. Not shared state: this is per-viewer, unlike every other field
   * on this model, since the server derives it from the viewer's own
   * ChannelMembership row (see server/presenters/channel.ts).
   */
  @Field
  @observable
  currentUserLastReadAt: string | null;

  /**
   * The active call's id, or null when no call is in progress. Shared state
   * synced from the server - whether *this* browser tab has joined it is
   * tracked separately, in CallStore.
   */
  @Field
  @observable
  callId: string | null;

  @Field
  @observable
  callStartedAt: string | null;

  @Field
  @observable
  callStartedById: string | null;

  /**
   * How many messages here the current user hasn't read. Per-viewer, like
   * `currentUserLastReadAt`. Excludes the user's own messages, so sending
   * one never makes a channel look unread to its author.
   */
  @Field
  @observable
  unreadCount: number;

  get isArchived() {
    return !!this.archivedAt;
  }

  /**
   * Whether this channel has messages the current user hasn't read yet.
   */
  get isUnread() {
    return this.unreadCount > 0;
  }

  /**
   * Whether this channel currently has an active call. Says nothing about
   * whether the current viewer has joined it - see CallStore for that.
   */
  get callInProgress() {
    return !!this.callId;
  }
}

export default Channel;
