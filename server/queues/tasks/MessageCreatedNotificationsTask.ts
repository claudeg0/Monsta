import { NotificationEventType } from "@shared/types";
import { UniqueConstraintError } from "sequelize";
import { Channel, Message, Notification } from "@server/models";
import type { User } from "@server/models";
import type { MessageEvent } from "@server/types";
import { BaseTask, TaskPriority } from "./base/BaseTask";

/** Maximum length of the plain-text snippet stored on aggregated rows. */
const SNIPPET_MAX_LENGTH = 140;

export default class MessageCreatedNotificationsTask extends BaseTask<MessageEvent> {
  public async perform(event: MessageEvent) {
    const message = await Message.findByPk(event.modelId);
    if (!message) {
      return;
    }
    const channel = await Channel.findByPk(message.channelId, {
      include: [
        {
          association: "memberships",
          include: [{ association: "user" }],
        },
      ],
    });
    if (!channel) {
      return;
    }

    const snippet = this.snippetFor(message);

    for (const membership of channel.memberships) {
      const recipient = membership.user;
      if (!recipient || recipient.id === message.createdById) {
        continue;
      }
      if (
        !recipient.subscribedToEventType(
          NotificationEventType.CreateChatMessages
        )
      ) {
        continue;
      }

      // Suppression: a read cursor current against this message means the
      // recipient has already seen it (likely while viewing the channel) -
      // no notification at all, on both the create and the aggregate path.
      if (membership.lastReadAt && membership.lastReadAt >= message.createdAt) {
        continue;
      }

      await this.createOrAggregate({
        recipient,
        message,
        channel,
        snippet,
      });
    }
  }

  /**
   * Creates a fresh aggregate row for the recipient, or folds the message
   * into their existing unviewed row. A concurrent task can win the race
   * between the lookup and the insert (enforced by the partial unique
   * index); that failure falls back to the aggregate path.
   */
  private async createOrAggregate({
    recipient,
    message,
    channel,
    snippet,
  }: {
    recipient: User;
    message: Message;
    channel: Channel;
    snippet: string;
  }) {
    const where = {
      event: NotificationEventType.CreateChatMessages,
      userId: recipient.id,
      channelId: channel.id,
      viewedAt: null,
      archivedAt: null,
    };

    const existing = await Notification.findOne({ where });
    if (existing) {
      // Aggregate in place: never touch createdAt (no revival bumping in
      // the panel) and never reset viewedAt - the lookup filters to live
      // rows, so this row is unread by definition.
      await existing.update({
        actorId: message.createdById,
        data: {
          messageCount: (existing.data?.messageCount ?? 1) + 1,
          snippet,
        },
      });
      return;
    }

    try {
      await Notification.create({
        event: NotificationEventType.CreateChatMessages,
        userId: recipient.id,
        actorId: message.createdById,
        teamId: channel.teamId,
        channelId: channel.id,
        data: { messageCount: 1, snippet },
      });
    } catch (err) {
      if (!(err instanceof UniqueConstraintError)) {
        throw err;
      }
      // Lost the create race to a concurrent task; that task's row is (or
      // will be) the live one - fold this message into whatever is live.
      const live = await Notification.findOne({ where });
      if (live) {
        await live.update({
          actorId: message.createdById,
          data: {
            messageCount: (live.data?.messageCount ?? 1) + 1,
            snippet,
          },
        });
      }
    }
  }

  /**
   * Builds the snippet stored on the notification: the message's plain
   * text, whitespace-collapsed and truncated.
   *
   * @param message the message to summarize
   * @returns the snippet text
   */
  private snippetFor(message: Message): string {
    const plain = message.toPlainText().replace(/\s+/g, " ").trim();
    return plain.length > SNIPPET_MAX_LENGTH
      ? `${plain.slice(0, SNIPPET_MAX_LENGTH)}…`
      : plain;
  }

  public get options() {
    return {
      priority: TaskPriority.Background,
    };
  }
}
