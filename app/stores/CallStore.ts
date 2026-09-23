import { action, computed, makeObservable, observable } from "mobx";
import type RootStore from "./RootStore";

/**
 * The provider-agnostic handle needed to join a call - mirrors
 * server/utils/daily.ts's CallSession. Kept as a separate client-side type
 * rather than importing the server file, which pulls in server-only code.
 */
export interface CallSession {
  /** The call id, which is also the Daily room name. */
  id: string;
  /** The full room URL the daily-js frame joins. */
  url: string;
  /** A meeting token authenticating this specific user to the room. */
  token: string;
}

/**
 * Tracks the call the current viewer has actively joined in *this browser
 * tab* - ephemeral UI state, not persisted. Whether a channel *has* an
 * active call at all is shared state that lives on the Channel model
 * itself (`callId` etc., synced from the server); this store only answers
 * "am I in it right now."
 *
 * The daily-js frame instance itself is not held here - nothing outside
 * CallOverlay needs it, so it stays local to that component as a ref.
 */
export default class CallStore {
  @observable
  channelId: string | null = null;

  @observable
  isOpen = false;

  /**
   * Whether the daily-js frame has actually joined the meeting yet. Drives
   * the "Joining…" header label, and gates the End affordance: a call that
   * hasn't been joined has a participant count of zero, which would
   * otherwise look like "last participant" and offer End prematurely.
   */
  @observable
  isJoined = false;

  @observable
  participantCount = 0;

  /**
   * The room url and meeting token for the current join, handed back by
   * `channels.startCall`. CallOverlay joins the daily-js frame with this -
   * it's carried here rather than re-fetched because a fresh token is
   * minted per join, so there's nowhere else to get it from once the
   * startCall response has been handled.
   */
  @observable
  session: CallSession | null = null;

  constructor(rootStore: RootStore) {
    this.rootStore = rootStore;
    makeObservable(this);
  }

  /**
   * Marks the given channel's call as joined, opening the overlay.
   *
   * @param channelId ID of the channel whose call is being joined
   * @param session the room url and token this tab will join with
   */
  @action
  public open(channelId: string, session: CallSession) {
    this.channelId = channelId;
    this.session = session;
    this.isOpen = true;
    this.isJoined = false;
    this.participantCount = 0;
  }

  /**
   * Closes the overlay and clears join state. Does not itself leave the
   * Daily call - CallOverlay's own cleanup effect does that in response to
   * this flipping to closed.
   */
  @action
  public close() {
    this.channelId = null;
    this.session = null;
    this.isOpen = false;
    this.isJoined = false;
    this.participantCount = 0;
  }

  /**
   * Marks the frame as fully joined to the meeting.
   */
  @action
  public markJoined() {
    this.isJoined = true;
  }

  /**
   * Whether the current viewer is the last remaining participant in the
   * call - the only situation in which End is offered (see
   * docs/video-call-plan.md §1). Requires an actual join: before it, the
   * participant count is zero and the rule would misfire.
   */
  @computed
  public get isLastParticipant() {
    return this.isJoined && this.participantCount <= 1;
  }

  /**
   * Updates the live participant count, used to decide whether the current
   * viewer is the last one in the room (and so gets offered "End").
   *
   * @param count number of participants currently present
   */
  @action
  public setParticipantCount(count: number) {
    this.participantCount = count;
  }

  private rootStore: RootStore;
}
