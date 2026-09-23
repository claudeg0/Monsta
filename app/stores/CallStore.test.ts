import stores from "~/stores";

const session = {
  id: "11111111-1111-1111-1111-111111111111",
  url: "https://example.daily.co/11111111-1111-1111-1111-111111111111",
  token: "meeting-token",
};

describe("CallStore", () => {
  const callStore = stores.callStore;

  beforeEach(() => {
    callStore.close();
  });

  test("open tracks the joined call and resets per-call state", () => {
    callStore.setParticipantCount(3);
    callStore.open("channel-1", session);

    expect(callStore.channelId).toBe("channel-1");
    expect(callStore.session).toEqual(session);
    expect(callStore.isOpen).toBe(true);
    // A fresh join starts un-joined with no participants - a stale count
    // from a previous call must not leak into the new one.
    expect(callStore.isJoined).toBe(false);
    expect(callStore.participantCount).toBe(0);
  });

  test("close clears all join state", () => {
    callStore.open("channel-1", session);
    callStore.markJoined();
    callStore.close();

    expect(callStore.channelId).toBeNull();
    expect(callStore.session).toBeNull();
    expect(callStore.isOpen).toBe(false);
    expect(callStore.isJoined).toBe(false);
    expect(callStore.participantCount).toBe(0);
  });

  test("End is not offered before the join completes, even alone", () => {
    // Before joined-meeting fires the participant count is zero, which
    // would read as "last participant" if join state weren't part of the
    // rule - the exact bug that offered End to two people joining at once.
    callStore.open("channel-1", session);
    expect(callStore.isLastParticipant).toBe(false);
  });

  test("End is offered to a joined participant alone in the call", () => {
    callStore.open("channel-1", session);
    callStore.markJoined();
    callStore.setParticipantCount(1);

    expect(callStore.isLastParticipant).toBe(true);
  });

  test("End is not offered while anyone else remains", () => {
    callStore.open("channel-1", session);
    callStore.markJoined();
    callStore.setParticipantCount(2);

    expect(callStore.isLastParticipant).toBe(false);
  });

  test("leaving the call again revokes the End affordance", () => {
    callStore.open("channel-1", session);
    callStore.markJoined();
    callStore.setParticipantCount(1);
    callStore.close();

    expect(callStore.isLastParticipant).toBe(false);
  });
});
