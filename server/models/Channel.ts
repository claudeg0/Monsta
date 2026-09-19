import type { InferAttributes, InferCreationAttributes } from "sequelize";
import {
  BelongsTo,
  Column,
  DataType,
  ForeignKey,
  HasMany,
  Scopes,
  Table,
} from "sequelize-typescript";
import ChannelMembership from "./ChannelMembership";
import Message from "./Message";
import Team from "./Team";
import User from "./User";
import IdModel from "./base/IdModel";

export enum ChannelType {
  DirectMessage = "dm",
  Group = "group",
}

/**
 * Represents a chat channel - either a 1:1 direct message between two users
 * or a named group conversation between three or more. Distinct from
 * Comment (document-anchored discussion) and from Group (an admin-managed
 * permission primitive) - see server/policies/channel.ts for why this is a
 * separate model rather than a repurposing of either.
 */
@Scopes(() => ({
  // Required before running any Channel ability check - the policy's
  // isChannelMember() walks the full membership list synchronously and
  // invariant()s if it isn't preloaded, rather than issuing a query.
  withMemberships: {
    include: [{ association: "memberships" }],
  },
}))
@Table({ tableName: "channels", modelName: "channel" })
class Channel extends IdModel<
  InferAttributes<Channel>,
  Partial<InferCreationAttributes<Channel>>
> {
  @Column(DataType.ENUM(...Object.values(ChannelType)))
  type: ChannelType;

  /**
   * Display name. Always null for a `dm` channel - the client derives a
   * display name from the other participant. Optional for a `group`
   * channel (falls back to a comma-joined participant list client-side).
   */
  @Column(DataType.STRING)
  name: string | null;

  @Column(DataType.DATE)
  lastMessageAt: Date | null;

  @Column(DataType.DATE)
  archivedAt: Date | null;

  /**
   * Whether the channel has been archived.
   */
  public get isArchived() {
    return !!this.archivedAt;
  }

  // associations

  @BelongsTo(() => Team, "teamId")
  team: Team;

  @ForeignKey(() => Team)
  @Column(DataType.UUID)
  teamId: string;

  @BelongsTo(() => User, "createdById")
  createdBy: User;

  @ForeignKey(() => User)
  @Column(DataType.UUID)
  createdById: string;

  @HasMany(() => ChannelMembership, "channelId")
  memberships: ChannelMembership[];

  @HasMany(() => Message, "channelId")
  messages: Message[];
}

export default Channel;
