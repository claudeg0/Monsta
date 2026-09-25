import { z } from "zod";
import { ChannelType } from "@server/models/Channel";
import { BaseSchema } from "@server/routes/api/schema";

const BaseIdSchema = z.object({
  id: z.uuid(),
});

export const ChannelsCreateSchema = BaseSchema.extend({
  body: z.object({
    type: z.enum(ChannelType),

    /**
     * The other participant(s) to create the channel with - the current
     * user is always included automatically. Exactly one id for a `dm`
     * channel (strict 1:1), one or more for a `group` channel.
     */
    userIds: z.array(z.uuid()).min(1),

    /** Display name - ignored for `dm` channels, optional for `group`. */
    name: z.string().max(100).optional(),
  }),
});

export type ChannelsCreateReq = z.infer<typeof ChannelsCreateSchema>;

export const ChannelsInfoSchema = BaseSchema.extend({
  body: BaseIdSchema,
});

export type ChannelsInfoReq = z.infer<typeof ChannelsInfoSchema>;

export const ChannelsListSchema = BaseSchema.extend({
  body: z.object({}),
});

export type ChannelsListReq = z.infer<typeof ChannelsListSchema>;

export const ChannelsMarkReadSchema = BaseSchema.extend({
  body: BaseIdSchema,
});

export type ChannelsMarkReadReq = z.infer<typeof ChannelsMarkReadSchema>;

export const ChannelsHideSchema = BaseSchema.extend({
  body: BaseIdSchema,
});

export type ChannelsHideReq = z.infer<typeof ChannelsHideSchema>;

export const ChannelsAddUserSchema = BaseSchema.extend({
  body: BaseIdSchema.extend({
    /** The team member to add to this group. */
    userId: z.uuid(),
  }),
});

export type ChannelsAddUserReq = z.infer<typeof ChannelsAddUserSchema>;

export const ChannelsLeaveSchema = BaseSchema.extend({
  body: BaseIdSchema,
});

export type ChannelsLeaveReq = z.infer<typeof ChannelsLeaveSchema>;

export const ChannelsStartCallSchema = BaseSchema.extend({
  body: BaseIdSchema,
});

export type ChannelsStartCallReq = z.infer<typeof ChannelsStartCallSchema>;

export const ChannelsEndCallSchema = BaseSchema.extend({
  body: BaseIdSchema,
});

export type ChannelsEndCallReq = z.infer<typeof ChannelsEndCallSchema>;
