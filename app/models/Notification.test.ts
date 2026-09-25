/* oxlint-disable */
import type { TFunction } from "i18next";
import { NotificationEventType } from "@shared/types";
import { ChannelType } from "~/models/Channel";
import stores from "~/stores";

const t = ((key: string, opts?: { count?: number }) =>
  `${key}:${opts?.count ?? ""}`) as unknown as TFunction;

function addChatNotification(channelId?: string) {
  return stores.notifications.add({
    id: "11111111-1111-1111-1111-111111111111",
    event: NotificationEventType.CreateChatMessages,
    channelId,
    data: { messageCount: 3, snippet: "hello there" },
  });
}

describe("Notification chat rows", () => {
  beforeEach(() => {
    stores.notifications.clear();
    stores.channels.clear();
    stores.users.clear();
  });

  test("path deep-links into the chat channel", () => {
    const notification = addChatNotification(
      "22222222-2222-2222-2222-222222222222"
    );
    expect(notification.path).toBe(
      "/chat/22222222-2222-2222-2222-222222222222"
    );
  });

  test("path is empty when channelId is absent", () => {
    const notification = addChatNotification();
    expect(notification.path).toBe("");
  });

  test("eventText carries the aggregated message count", () => {
    const notification = addChatNotification(
      "22222222-2222-2222-2222-222222222222"
    );
    expect(notification.eventText(t)).toContain("3");
  });

  test("subject uses the channel name for group channels", () => {
    stores.channels.add({
      id: "22222222-2222-2222-2222-222222222222",
      type: ChannelType.Group,
      name: "Engineering",
      memberIds: [],
    });
    const notification = addChatNotification(
      "22222222-2222-2222-2222-222222222222"
    );
    expect(notification.subject).toBe("Engineering");
  });

  test("subject derives a DM name from the other participant", () => {
    const me = stores.users.add({
      id: "33333333-3333-3333-3333-333333333333",
      name: "Me",
    });
    stores.auth.currentUserId = me.id;
    stores.users.add({
      id: "44444444-4444-4444-4444-444444444444",
      name: "Steph",
    });
    stores.channels.add({
      id: "22222222-2222-2222-2222-222222222222",
      type: ChannelType.DirectMessage,
      name: null,
      memberIds: [
        "33333333-3333-3333-3333-333333333333",
        "44444444-4444-4444-4444-444444444444",
      ],
    });
    const notification = addChatNotification(
      "22222222-2222-2222-2222-222222222222"
    );
    expect(notification.subject).toBe("Steph");
  });

  test("subject falls back gracefully when the channel is not loaded", () => {
    const notification = addChatNotification(
      "22222222-2222-2222-2222-222222222222"
    );
    expect(notification.subject).toBe("a conversation");
  });
});
