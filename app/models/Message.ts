import { observable } from "mobx";
import type { ProsemirrorData } from "@shared/types";
import User from "~/models/User";
import Channel from "./Channel";
import Model from "./base/Model";
import Field from "./decorators/Field";
import Relation from "./decorators/Relation";

class Message extends Model {
  static modelName = "Message";

  constructor(fields: Record<string, unknown>, store: Model["store"]) {
    super(fields, store);
    this.initialize(fields);
  }

  /**
   * The Prosemirror data representing the message content - same restricted
   * schema as Comment, so @-mentions render with the existing components.
   */
  @Field
  @observable.shallow
  data: ProsemirrorData;

  @Field
  @observable
  channelId: string;

  @Relation(() => Channel, { onDelete: "cascade" })
  channel: Channel;

  @Relation(() => Message, { onDelete: "cascade" })
  parentMessage?: Message;

  @Field
  @observable
  parentMessageId: string | null;

  @Relation(() => User)
  createdBy: User;

  createdById: string;

  /**
   * Set when the message has been edited since it was created. No separate
   * revision history is retained - edits overwrite `data` in place.
   */
  @Field
  @observable
  editedAt: string | null;

  get isEdited() {
    return !!this.editedAt;
  }
}

export default Message;
