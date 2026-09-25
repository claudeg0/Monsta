import type { Message } from "@server/models";
import presentUser from "./user";

export default function present(message: Message) {
  return {
    id: message.id,
    channelId: message.channelId,
    data: message.data,
    parentMessageId: message.parentMessageId,
    // Guarded the same way presentChannel guards its own createdBy - a
    // caller that forgot to eager-load the association gets an incomplete
    // payload instead of a 500. Confirmed live that an unguarded call here
    // crashes the whole request when the association isn't loaded (this
    // exact gap broke messages.list before the callers were fixed too).
    createdBy: message.createdBy ? presentUser(message.createdBy) : undefined,
    createdById: message.createdById,
    editedAt: message.editedAt,
    createdAt: message.createdAt,
    updatedAt: message.updatedAt,
  };
}
