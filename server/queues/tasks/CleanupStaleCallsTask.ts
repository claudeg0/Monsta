import { Op } from "sequelize";
import { Hour } from "@shared/utils/time";
import { toError } from "@shared/utils/error";
import { createContext } from "@server/context";
import env from "@server/env";
import Logger from "@server/logging/Logger";
import { Channel } from "@server/models";
import { sequelize } from "@server/storage/database";
import { getRoom, roomHasOngoingMeeting } from "@server/utils/daily";
import { TaskPriority } from "./base/BaseTask";
import type { Props } from "./base/CronTask";
import { CronTask, TaskInterval } from "./base/CronTask";

/**
 * A call started longer ago than this is a cleanup candidate. Long enough
 * that nobody can be mid-reconnect, short enough that a missed call_ended
 * (webhook delivery failure, or a room deleted out-of-band) is cleared
 * within the hour.
 */
const STALE_AFTER_MS = Hour.ms;

/**
 * Hourly backstop for call state that outlived its room. The primary
 * lifecycle is call_ended via the API route or the Daily meeting.ended
 * webhook; this task only sweeps what those missed, and only after Daily
 * itself confirms the call is dead - a room that no longer exists, or one
 * with no meeting in progress. A live meeting always wins, and any provider
 * error (5xx, network, unconfigured) means "unknown", which is left alone:
 * an hour more of a stuck badge is cheap, ending a live call is not.
 */
export default class CleanupStaleCallsTask extends CronTask {
  public async perform({ limit }: Props) {
    // Without Daily credentials no call can be verified - and none could
    // have been started - so local/test environments skip entirely.
    if (!env.DAILY_API_KEY) {
      return;
    }

    const channels = await Channel.findAll({
      where: {
        callId: { [Op.ne]: null },
        callStartedAt: { [Op.lt]: new Date(Date.now() - STALE_AFTER_MS) },
      },
      limit,
    });

    for (const channel of channels) {
      try {
        await this.cleanupChannel(channel);
      } catch (err) {
        // One channel's failure shouldn't block the rest of the sweep.
        Logger.error("Failed to clean up stale call", toError(err), {
          channelId: channel.id,
        });
      }
    }
  }

  public get cron() {
    return { interval: TaskInterval.Hour };
  }

  public get options() {
    return {
      attempts: 1,
      priority: TaskPriority.Background,
    };
  }

  /**
   * Ends the channel's call if Daily confirms it is dead.
   *
   * @param channel a channel whose call started more than STALE_AFTER_MS ago
   */
  private async cleanupChannel(channel: Channel): Promise<void> {
    const callId = channel.callId;
    if (!callId) {
      return;
    }

    try {
      const room = await getRoom(callId);
      if (room !== null && (await roomHasOngoingMeeting(callId))) {
        return;
      }
    } catch (err) {
      // Provider unreachable - "unknown" is not "stale".
      Logger.warn("Skipping stale call cleanup, provider lookup failed", {
        callId,
        channelId: channel.id,
        error: String(err),
      });
      return;
    }

    Logger.info("task", `Ending stale call ${callId} in channel ${channel.id}`);

    // The lookup above raced with nothing while holding no lock, so
    // re-fetch under lock and confirm the same call is still the active
    // one before clearing it - a call ended and restarted in the meantime
    // must not be clobbered.
    await sequelize.transaction(async (transaction) => {
      const locked = await Channel.findByPk(channel.id, {
        transaction,
        lock: { level: transaction.LOCK.UPDATE, of: Channel },
      });
      if (!locked || locked.callId !== callId) {
        return;
      }
      await locked.endCall(createContext({ transaction }));
    });
  }
}
