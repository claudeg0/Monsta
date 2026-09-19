import { action, makeObservable, observable } from "mobx";
import type RootStore from "./RootStore";

/**
 * Tracks which team members are currently online for chat, reconciling two
 * different sources of the same state: a one-time initial snapshot (sent
 * once per socket connection, right after authentication) and live
 * `presence.online`/`presence.offline` deltas that follow it. These are not
 * independent sources of truth - the snapshot only ever seeds a user's
 * state if a delta hasn't already set it on this connection, and a delta is
 * always authoritative regardless of whether it arrives before or after the
 * snapshot response. See docs/plans note on presence for why the snapshot
 * exists at all (there's no DB row to reconcile via REST - this is live
 * socket state, not persisted).
 */
export default class ChatPresenceStore {
  @observable
  private onlineUserIds: Set<string> = new Set();

  constructor(rootStore: RootStore) {
    this.rootStore = rootStore;
    makeObservable(this);
  }

  /**
   * Reset all tracked state. Call this at the start of every new socket
   * connection (including reconnects) - a disconnect means every
   * previously-known online/offline state is stale until this connection's
   * own snapshot and deltas rebuild it from scratch.
   */
  @action
  public reset() {
    this.onlineUserIds.clear();
    this.deltaAppliedUserIds.clear();
  }

  /**
   * Apply the one-time initial snapshot of currently-online users. Only
   * seeds users not already touched by a live delta on this connection -
   * without that check, a snapshot computed before a delta but delivered
   * after it (the two travel independent, unordered paths) could silently
   * stomp the more recent, correct state.
   *
   * @param userIds IDs of users who were online at snapshot time.
   */
  @action
  public applySnapshot(userIds: string[]) {
    userIds.forEach((userId) => {
      if (!this.deltaAppliedUserIds.has(userId)) {
        this.onlineUserIds.add(userId);
      }
    });
  }

  /**
   * Apply a live presence.online event. Always authoritative, regardless of
   * arrival order relative to the initial snapshot.
   *
   * @param userId ID of the user who came online.
   */
  @action
  public markOnline(userId: string) {
    this.deltaAppliedUserIds.add(userId);
    this.onlineUserIds.add(userId);
  }

  /**
   * Apply a live presence.offline event. Always authoritative.
   *
   * The server only ever sends this once a user's *last* connected socket
   * has disconnected, checked cluster-wide (see
   * `reportOfflineIfLastConnection` in server/services/websockets.ts) - so
   * a user with multiple tabs/devices open never reads as offline here
   * until every one of them has actually disconnected. This store does not
   * need, and deliberately does not implement, its own multi-connection
   * counting to get that right - it only reflects events the server has
   * already deduplicated correctly.
   *
   * @param userId ID of the user who went offline.
   */
  @action
  public markOffline(userId: string) {
    this.deltaAppliedUserIds.add(userId);
    this.onlineUserIds.delete(userId);
  }

  /**
   * Whether the given user is currently online.
   *
   * @param userId ID of the user to check.
   */
  public isOnline(userId: string): boolean {
    return this.onlineUserIds.has(userId);
  }

  /**
   * userIds whose online/offline state has been set by a live delta event
   * since the current connection was established - see applySnapshot.
   */
  private deltaAppliedUserIds: Set<string> = new Set();

  private rootStore: RootStore;
}
