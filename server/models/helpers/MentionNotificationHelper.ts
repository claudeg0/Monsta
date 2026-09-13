import { Week } from "@shared/utils/time";
import Logger from "@server/logging/Logger";
import Redis from "@server/storage/redis";

const keyPrefix = "mention-notified";

/**
 * How long a claim is remembered. A mention node keeps its id for the life of
 * the document, so this only needs to outlive the window in which the same
 * mention could be seen again – every document save while editing continues,
 * plus the later debounced revision.
 */
const ttl = Week.seconds;

/**
 * Claims the right to notify for a single mention, so that a mention is only
 * ever notified once no matter how many times it is seen.
 *
 * Document mentions are notified immediately on save rather than waiting for a
 * revision, which means the same mention is seen on every subsequent save and
 * again when the debounced revision is eventually created. The claim is atomic
 * so concurrent workers cannot both notify for the same mention.
 *
 * @param mentionId The id of the mention node, unique per mention.
 * @returns true if the caller should send the notification, false if it has
 * already been notified.
 */
export async function claimMentionNotification(
  mentionId: string
): Promise<boolean> {
  try {
    const claimed = await Redis.defaultClient.set(
      `${keyPrefix}:${mentionId}`,
      "1",
      "EX",
      ttl,
      "NX"
    );
    return claimed === "OK";
  } catch (err) {
    // Failing to reach Redis must not stop a mention being delivered – the
    // worst case is a duplicate notification rather than a missing one.
    Logger.warn("Could not claim mention notification, notifying anyway", {
      mentionId,
      error: err,
    });
    return true;
  }
}
