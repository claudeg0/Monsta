import { Node } from "prosemirror-model";
import type { InferAttributes, InferCreationAttributes } from "sequelize";
import {
  BelongsTo,
  Column,
  DataType,
  ForeignKey,
  Length,
  Table,
} from "sequelize-typescript";
import type { ProsemirrorData } from "@shared/types";
import { ProsemirrorHelper } from "@shared/utils/ProsemirrorHelper";
import { CommentValidation } from "@shared/validations";
import { commentSchema, serializer } from "@server/editor";
import Channel from "./Channel";
import User from "./User";
import ParanoidModel from "./base/ParanoidModel";
import { SkipChangeset } from "./decorators/Changeset";
import TextLength from "./validators/TextLength";

/**
 * A single chat message within a Channel. Content is stored in the same
 * restricted ProseMirror JSON format as Comment.data, so @-mentions
 * (user/document/collection) work with the existing mention infrastructure
 * with no new parser needed. Reuses CommentValidation.maxLength as an
 * interim length bound - split into a dedicated MessageValidation if
 * chat-specific limits are ever needed.
 */
@Table({ tableName: "messages", modelName: "message" })
class Message extends ParanoidModel<
  InferAttributes<Message>,
  Partial<InferCreationAttributes<Message>>
> {
  @TextLength({
    max: CommentValidation.maxLength,
    msg: `Message must be less than ${CommentValidation.maxLength} characters`,
  })
  @Length({
    max: CommentValidation.maxLength * 10,
    msg: `Message data is too large`,
  })
  @Column(DataType.JSONB)
  @SkipChangeset
  data: ProsemirrorData;

  /**
   * Set when the message is edited after creation. No separate revision
   * history is retained in v1 - edits overwrite `data` in place and this
   * timestamp backs a simple "(edited)" indicator client-side.
   */
  @Column(DataType.DATE)
  editedAt: Date | null;

  /**
   * Whether the message has been edited since it was created.
   */
  public get isEdited() {
    return !!this.editedAt;
  }

  /**
   * Convert the message data to plain text.
   *
   * @returns The plain text representation of the message data.
   */
  public toPlainText() {
    const node = Node.fromJSON(commentSchema, this.data);
    return ProsemirrorHelper.toPlainText(node);
  }

  /**
   * Convert the message data to markdown.
   *
   * @returns The markdown representation of the message data.
   */
  public toMarkdown() {
    const node = Node.fromJSON(commentSchema, this.data);
    return serializer
      .serialize(node)
      .replace(/(^|\n)\\(\n|$)/g, "\n\n")
      .trim();
  }

  // associations

  @BelongsTo(() => Channel, "channelId")
  channel: Channel;

  @ForeignKey(() => Channel)
  @Column(DataType.UUID)
  channelId: string;

  @BelongsTo(() => User, "createdById")
  createdBy: User;

  @ForeignKey(() => User)
  @Column(DataType.UUID)
  createdById: string;

  @BelongsTo(() => Message, "parentMessageId")
  parentMessage: Message | null;

  @ForeignKey(() => Message)
  @Column(DataType.UUID)
  parentMessageId: string | null;
}

export default Message;
