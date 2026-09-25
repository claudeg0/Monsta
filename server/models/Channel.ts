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
import { v4 as uuidv4 } from "uuid";
import Logger from "@server/logging/Logger";
import type { APIContext } from "@server/types";
import type { CallSession } from "@server/utils/daily";
import {
  createMeetingToken,
  createRoom,
  deleteRoom,
  roomUrl,
} from "@server/utils/daily";
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
   * The active call's id, which is also the Daily room name. Null means no
   * call - the three call columns are always set and cleared together.
   */
  @Column(DataType.UUID)
  callId: string | null;

  @Column(DataType.DATE)
  callStartedAt: Date | null;

  /**
   * Whether the channel has been archived.
   */
  public get isArchived() {
    return !!this.archivedAt;
  }

  /**
   * Whether the channel currently has an active call.
   */
  public get callInProgress() {
    return !!this.callId;
  }

  /**
   * Starts a call in this channel, or joins the one already running - the
   * caller is expected to have locked the channel row so two concurrent
   * starts can't both take the start path.
   *
   * On the start path a Daily room is created, the call columns are
   * persisted, and a `channels.call_started` event is published; if the
   * persist fails the room is deleted again so it can't linger unreferenced.
   * On the join path nothing is written and no event is published - only a
   * fresh meeting token is minted for the existing room.
   *
   * @param ctx the API context of the member starting or joining the call
   * @returns the session (room url and meeting token) for the caller
   * @throws VideoProviderError if the video provider call fails, in which
   * case the channel's call columns are left untouched
   */
  public async startCall(ctx: APIContext): Promise<CallSession> {
    const { user } = ctx.state.auth;

    if (this.callId) {
      const token = await createMeetingToken({
        roomName: this.callId,
        userName: user.name,
        userId: user.id,
      });
      return { id: this.callId, url: roomUrl(this.callId), token };
    }

    const callId = uuidv4();
    const room = await createRoom(callId);

    this.callId = callId;
    this.callStartedAt = new Date();
    this.callStartedById = user.id;

    try {
      await this.saveWithCtx(ctx, undefined, { name: "call_started" });
    } catch (err) {
      // The room exists at Daily but the write that references it failed -
      // delete it again, best-effort, so it can't linger unreferenced.
      try {
        await deleteRoom(callId);
      } catch (deleteErr) {
        Logger.warn("Failed to delete Daily room after failed call start", {
          callId,
          error: String(deleteErr),
        });
      }
      throw err;
    }

    const token = await createMeetingToken({
      roomName: callId,
      userName: user.name,
      userId: user.id,
    });
    return { id: callId, url: room.url, token };
  }

  /**
   * Ends the active call, if any: clears the call columns, publishes a
   * `channels.call_ended` event, then deletes the Daily room (kicking any
   * remaining participants). Room deletion is best-effort - a failure is
   * logged, and the room's `exp` refuses new joins within 24h regardless.
   *
   * @param ctx the API context of the actor ending the call (may be a
   * synthetic context from the Daily webhook)
   * @returns whether a call was active; ending an idle channel is a no-op
   */
  public async endCall(ctx: APIContext): Promise<boolean> {
    if (!this.callId) {
      return false;
    }

    const callId = this.callId;
    this.callId = null;
    this.callStartedAt = null;
    this.callStartedById = null;

    await this.saveWithCtx(ctx, undefined, { name: "call_ended" });

    try {
      await deleteRoom(callId);
    } catch (err) {
      Logger.warn("Failed to delete Daily room", {
        callId,
        error: String(err),
      });
    }
    return true;
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

  @BelongsTo(() => User, "callStartedById")
  callStartedBy: User | null;

  @ForeignKey(() => User)
  @Column(DataType.UUID)
  callStartedById: string | null;

  @HasMany(() => ChannelMembership, "channelId")
  memberships: ChannelMembership[];

  @HasMany(() => Message, "channelId")
  messages: Message[];
}

export default Channel;
