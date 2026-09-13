import { MentionType, NotificationEventType } from "@shared/types";
import { Document, Group, GroupUser, Notification, User } from "@server/models";
import { DocumentHelper } from "@server/models/helpers/DocumentHelper";
import { claimMentionNotification } from "@server/models/helpers/MentionNotificationHelper";
import type { DocumentEvent } from "@server/types";
import { canUserAccessDocument } from "@server/utils/permissions";
import { BaseTask, TaskPriority } from "./base/BaseTask";

/**
 * Notifies users mentioned in a document body as soon as the document is
 * saved.
 *
 * Every other notification triggered by editing a document intentionally waits
 * for the debounce in DebounceProcessor, so that a burst of edits produces a
 * single revision and a single "document updated" notification. A mention is
 * different: it is a deliberate, low frequency act that someone is usually
 * waiting on a reply to, so it should not be held behind that window.
 *
 * Because this runs on every save, the same mention is seen repeatedly, and it
 * is seen again by RevisionCreatedNotificationsTask once the debounced revision
 * is created. Each mention is therefore claimed before notifying so it is only
 * ever delivered once.
 */
export default class DocumentMentionedNotificationsTask extends BaseTask<DocumentEvent> {
  public async perform(event: DocumentEvent) {
    const document = await Document.findByPk(event.documentId, {
      includeState: true,
    });
    if (!document) {
      return;
    }

    await this.notifyUserMentions(event, document);
    await this.notifyGroupMentions(event, document);
  }

  private async notifyUserMentions(event: DocumentEvent, document: Document) {
    const mentions = DocumentHelper.parseMentions(document, {
      type: MentionType.User,
    });

    for (const mention of mentions) {
      const recipient = await User.findByPk(mention.modelId);

      if (
        !recipient ||
        !recipient.subscribedToEventType(
          NotificationEventType.MentionedInDocument
        ) ||
        !(await canUserAccessDocument(recipient, document.id))
      ) {
        continue;
      }

      if (!(await claimMentionNotification(mention.id))) {
        continue;
      }

      await Notification.create({
        event: NotificationEventType.MentionedInDocument,
        userId: recipient.id,
        actorId: mention.actorId ?? event.actorId,
        teamId: document.teamId,
        documentId: document.id,
      });
    }
  }

  private async notifyGroupMentions(event: DocumentEvent, document: Document) {
    const groupMentions = DocumentHelper.parseMentions(document, {
      type: MentionType.Group,
    });

    for (const groupMention of groupMentions) {
      const group = await Group.findByPk(groupMention.modelId);
      if (!group || group.disableMentions) {
        continue;
      }

      if (!(await claimMentionNotification(groupMention.id))) {
        continue;
      }

      const groupUsers = await GroupUser.findAll({
        where: { groupId: groupMention.modelId },
        order: [["permission", "ASC"]],
      });

      const notified = new Set<string>();

      for (const groupUser of groupUsers) {
        if (notified.has(groupUser.userId)) {
          continue;
        }

        const recipient = await User.findByPk(groupUser.userId);

        if (
          !recipient ||
          recipient.id === (groupMention.actorId ?? event.actorId) ||
          !recipient.subscribedToEventType(
            NotificationEventType.GroupMentionedInDocument
          ) ||
          !(await canUserAccessDocument(recipient, document.id))
        ) {
          continue;
        }

        await Notification.create({
          event: NotificationEventType.GroupMentionedInDocument,
          groupId: group.id,
          userId: recipient.id,
          actorId: groupMention.actorId ?? event.actorId,
          teamId: document.teamId,
          documentId: document.id,
        });

        notified.add(groupUser.userId);
      }
    }
  }

  public get options() {
    return {
      priority: TaskPriority.Normal,
    };
  }
}
