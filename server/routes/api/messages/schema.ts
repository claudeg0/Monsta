import { z } from "zod";
import { commentSchema } from "@server/editor";
import { BaseSchema, ProsemirrorSchema } from "@server/routes/api/schema";

const BaseIdSchema = z.object({
  id: z.uuid(),
});

export const MessagesCreateSchema = BaseSchema.extend({
  body: z.object({
    /** Client-generated id, so the client can render the message
     * optimistically and reconcile the same row once the server responds -
     * same convention as comments.create. Falls back to a server-generated
     * id when omitted. */
    id: z.uuid().optional(),

    channelId: z.uuid(),

    /** Reply to this message - no threading UI in v1, but the column and
     * this input both exist so a later UI addition needs no migration. */
    parentMessageId: z.uuid().optional(),

    /** Create the message with this rich-text data directly. */
    data: ProsemirrorSchema({ schema: commentSchema }).optional(),

    /** Create the message by parsing this plain text/markdown. */
    text: z.string().optional(),
  }),
});

export type MessagesCreateReq = z.infer<typeof MessagesCreateSchema>;

export const MessagesListSchema = BaseSchema.extend({
  body: z.object({
    channelId: z.uuid(),
  }),
});

export type MessagesListReq = z.infer<typeof MessagesListSchema>;

export const MessagesUpdateSchema = BaseSchema.extend({
  body: BaseIdSchema.extend({
    data: ProsemirrorSchema({ schema: commentSchema }).optional(),
    text: z.string().optional(),
  }),
});

export type MessagesUpdateReq = z.infer<typeof MessagesUpdateSchema>;

export const MessagesDeleteSchema = BaseSchema.extend({
  body: BaseIdSchema,
});

export type MessagesDeleteReq = z.infer<typeof MessagesDeleteSchema>;
