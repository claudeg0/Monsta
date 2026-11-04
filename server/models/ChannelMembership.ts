import type { InferAttributes, InferCreationAttributes } from "sequelize";
import {
  BelongsTo,
  Column,
  DataType,
  ForeignKey,
  Table,
} from "sequelize-typescript";
import Channel from "./Channel";
import User from "./User";
import IdModel from "./base/IdModel";

/**
 * Join model: a user's membership in a Channel, plus their read-cursor
 * (lastReadAt) for unread tracking - not a per-message read receipt. Hard-
 * deleted on leave, mirroring GroupUser rather than being paranoid: there's
 * no need to retain a tombstone of someone having left a conversation.
 */
@Table({ tableName: "channel_memberships", modelName: "channel_membership" })
class ChannelMembership extends IdModel<
  InferAttributes<ChannelMembership>,
  Partial<InferCreationAttributes<ChannelMembership>>
> {
  /** Membership changes are events about the channel, not about a join row
   * nothing else refers to - so they publish as `channels.*`. */
  static eventNamespace = "channels";

  /**
   * Events record this in place of the row's own id (see Model.insertEvent),
   * so a membership event carries the channel it concerns. The websocket
   * processor needs that to move sockets in and out of the channel room, and
   * on removal the row itself is already gone by the time it runs.
   */
  get modelId() {
    return this.channelId;
  }

  @Column(DataType.DATE)
  lastReadAt: Date | null;

  /**
   * When this user hid the conversation from their own list. Null means
   * visible. Per-viewer, like lastReadAt - hiding removes nothing and affects
   * nobody else's copy. Compared against the channel's lastMessageAt when
   * listing, so a hidden conversation returns on its own once there's
   * something new in it.
   */
  @Column(DataType.DATE)
  hiddenAt: Date | null;

  // associations

  @BelongsTo(() => Channel, "channelId")
  channel: Channel;

  @ForeignKey(() => Channel)
  @Column(DataType.UUID)
  channelId: string;

  @BelongsTo(() => User, "userId")
  user: User;

  @ForeignKey(() => User)
  @Column(DataType.UUID)
  userId: string;
}

export default ChannelMembership;
