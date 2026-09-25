import { NotificationEventType } from "@shared/types";
import BaseEmail from "@server/emails/templates/BaseEmail";
import { ChannelMembership, Notification } from "@server/models";
import EmailsProcessor from "@server/queues/processors/EmailsProcessor";
import { buildChannel, buildMessage, buildUser } from "@server/test/factories";
import MessageCreatedNotificationsTask from "./MessageCreatedNotificationsTask";

const ip = "127.0.0.1";

async function setupChannel() {
  const author = await buildUser();
  const recipient = await buildUser({ teamId: author.teamId });
  const channel = await buildChannel({
    teamId: author.teamId,
    createdById: author.id,
    memberIds: [author.id, recipient.id],
  });
  return { author, recipient, channel };
}

async function markChannelRead(channelId: string, userId: string) {
  await ChannelMembership.update(
    { lastReadAt: new Date() },
    { where: { channelId, userId } }
  );
}

function eventFor(
  message: { id: string },
  actorId: string,
  teamId: string
): {
  name: "messages.create";
  modelId: string;
  actorId: string;
  teamId: string;
  ip: string;
} {
  return {
    name: "messages.create",
    modelId: message.id,
    actorId,
    teamId,
    ip,
  };
}

describe("MessageCreatedNotificationsTask", () => {
  test("creates one aggregated row per non-author member", async () => {
    const { author, recipient, channel } = await setupChannel();
    const message = await buildMessage({
      channelId: channel.id,
      createdById: author.id,
    });

    await new MessageCreatedNotificationsTask().perform(
      eventFor(message, author.id, channel.teamId)
    );

    const notifications = await Notification.findAll({
      where: { channelId: channel.id },
    });
    expect(notifications).toHaveLength(1);
    expect(notifications[0].userId).toBe(recipient.id);
    expect(notifications[0].event).toBe(
      NotificationEventType.CreateChatMessages
    );
    expect(notifications[0].actorId).toBe(author.id);
    expect(notifications[0].documentId).toBeNull();
    expect(notifications[0].commentId).toBeNull();
    expect(notifications[0].channelId).toBe(channel.id);
    expect(notifications[0].data?.messageCount).toBe(1);
    expect(notifications[0].data?.snippet).toBeTruthy();
    expect(notifications[0].viewedAt).toBeNull();
  });

  test("aggregates subsequent messages into the same row without touching createdAt", async () => {
    const { author, channel } = await setupChannel();
    const first = await buildMessage({
      channelId: channel.id,
      createdById: author.id,
    });

    const task = new MessageCreatedNotificationsTask();
    await task.perform(eventFor(first, author.id, channel.teamId));
    const created = await Notification.findOne({
      where: { channelId: channel.id },
    });
    expect(created).toBeTruthy();

    const second = await buildMessage({
      channelId: channel.id,
      createdById: author.id,
    });
    await task.perform(eventFor(second, author.id, channel.teamId));

    const notifications = await Notification.findAll({
      where: { channelId: channel.id },
    });
    expect(notifications).toHaveLength(1);
    expect(notifications[0].id).toBe(created!.id);
    expect(notifications[0].data?.messageCount).toBe(2);
    expect(notifications[0].actorId).toBe(author.id);
    expect(notifications[0].viewedAt).toBeNull();
    // No revival bumping: the row keeps its original sort position.
    expect(notifications[0].createdAt).toEqual(created!.createdAt);
  });

  test("suppresses creation when the recipient's read cursor covers the message", async () => {
    const { author, recipient, channel } = await setupChannel();
    const message = await buildMessage({
      channelId: channel.id,
      createdById: author.id,
    });

    // The user reads immediately after the message lands (the plan's race
    // test): cursor >= message.createdAt by the time the task executes.
    await markChannelRead(channel.id, recipient.id);

    await new MessageCreatedNotificationsTask().perform(
      eventFor(message, author.id, channel.teamId)
    );

    expect(await Notification.count({ where: { channelId: channel.id } })).toBe(
      0
    );
  });

  test("suppresses aggregation when the recipient's read cursor becomes current", async () => {
    const { author, recipient, channel } = await setupChannel();
    const task = new MessageCreatedNotificationsTask();

    const first = await buildMessage({
      channelId: channel.id,
      createdById: author.id,
    });
    await task.perform(eventFor(first, author.id, channel.teamId));
    const before = await Notification.findOne({
      where: { channelId: channel.id },
    });
    expect(before?.data?.messageCount).toBe(1);

    // Recipient catches up after the second message lands but before its
    // task runs - the cursor must cover the new message to suppress.
    const second = await buildMessage({
      channelId: channel.id,
      createdById: author.id,
    });
    await markChannelRead(channel.id, recipient.id);
    await task.perform(eventFor(second, author.id, channel.teamId));

    const after = await Notification.findOne({
      where: { channelId: channel.id },
    });
    expect(after?.id).toBe(before!.id);
    expect(after?.data?.messageCount).toBe(1);
    expect(after?.actorId).toBe(author.id);
  });

  test("does not resurrect a viewed row - the next message starts a fresh row", async () => {
    const { author, recipient, channel } = await setupChannel();
    const task = new MessageCreatedNotificationsTask();

    const first = await buildMessage({
      channelId: channel.id,
      createdById: author.id,
    });
    await task.perform(eventFor(first, author.id, channel.teamId));
    const viewed = await Notification.findOne({
      where: { channelId: channel.id },
    });
    await viewed!.update({ viewedAt: new Date() });

    const second = await buildMessage({
      channelId: channel.id,
      createdById: author.id,
    });
    await task.perform(eventFor(second, author.id, channel.teamId));

    const rows = await Notification.findAll({
      where: { channelId: channel.id },
      order: [["createdAt", "ASC"]],
    });
    expect(rows).toHaveLength(2);
    expect(rows[0].id).toBe(viewed!.id);
    expect(rows[0].data?.messageCount).toBe(1);
    expect(rows[1].id).not.toBe(viewed!.id);
    expect(rows[1].viewedAt).toBeNull();
    expect(rows[1].data?.messageCount).toBe(1);
    expect(rows[1].userId).toBe(recipient.id);
  });

  test("skips recipients who have disabled the event type", async () => {
    const { author, recipient, channel } = await setupChannel();
    recipient.setNotificationEventType(
      NotificationEventType.CreateChatMessages,
      false
    );
    await recipient.save();

    const message = await buildMessage({
      channelId: channel.id,
      createdById: author.id,
    });
    await new MessageCreatedNotificationsTask().perform(
      eventFor(message, author.id, channel.teamId)
    );

    expect(await Notification.count({ where: { channelId: channel.id } })).toBe(
      0
    );
  });

  test("never sends email for chat notifications", async () => {
    const { author, channel } = await setupChannel();
    const message = await buildMessage({
      channelId: channel.id,
      createdById: author.id,
    });

    const task = new MessageCreatedNotificationsTask();
    await task.perform(eventFor(message, author.id, channel.teamId));

    const notification = await Notification.findOne({
      where: { channelId: channel.id },
    });
    expect(notification).toBeTruthy();

    const scheduleSpy = vi.spyOn(BaseEmail.prototype, "schedule");
    await new EmailsProcessor().perform({
      name: "notifications.create",
      modelId: notification!.id,
      teamId: channel.teamId,
      userId: notification!.userId,
      actorId: author.id,
      ip,
    });

    expect(scheduleSpy).not.toHaveBeenCalled();
    expect((await notification!.reload()).emailedAt).toBeNull();
  });

  test("truncates long message text in the snippet", async () => {
    const { author, channel } = await setupChannel();
    const message = await buildMessage({
      channelId: channel.id,
      createdById: author.id,
      data: {
        type: "doc",
        content: [
          {
            type: "paragraph",
            content: [{ type: "text", text: "a".repeat(500) }],
          },
        ],
      },
    });

    await new MessageCreatedNotificationsTask().perform(
      eventFor(message, author.id, channel.teamId)
    );

    const notification = await Notification.findOne({
      where: { channelId: channel.id },
    });
    expect(notification!.data!.snippet!.length).toBeLessThanOrEqual(141);
    expect(notification!.data!.snippet!.endsWith("…")).toBe(true);
  });
});
