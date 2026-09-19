import stores from "~/stores";

describe("ChatPresenceStore", () => {
  const userA = "11111111-1111-1111-1111-111111111111";
  const userB = "22222222-2222-2222-2222-222222222222";

  const presence = stores.chatPresence;

  beforeEach(() => {
    presence.reset();
  });

  test("snapshot seeds users as online", () => {
    presence.applySnapshot([userA, userB]);
    expect(presence.isOnline(userA)).toBe(true);
    expect(presence.isOnline(userB)).toBe(true);
  });

  test("a user absent from the snapshot is not online", () => {
    presence.applySnapshot([userA]);
    expect(presence.isOnline(userB)).toBe(false);
  });

  test("a delta applied before the snapshot arrives is not overwritten by it", () => {
    // Simulates the real race: the snapshot query started before userA
    // disconnected, so it still lists them as online by the time its
    // response is applied - but the live offline delta for that same
    // transition already arrived and was applied first.
    presence.markOffline(userA);
    presence.applySnapshot([userA]);
    expect(presence.isOnline(userA)).toBe(false);
  });

  test("a delta applied after the snapshot is always authoritative", () => {
    presence.applySnapshot([userA]);
    presence.markOffline(userA);
    expect(presence.isOnline(userA)).toBe(false);

    presence.markOnline(userB);
    expect(presence.isOnline(userB)).toBe(true);
  });

  test("multiple tabs: redundant online events are idempotent, and the user stays online until the server actually reports them offline", () => {
    // The server only ever emits offline once every one of a user's
    // sockets has disconnected (checked cluster-wide) - this store's job
    // is just to reflect that, not to count connections itself. So from
    // this store's perspective, two tabs simply means two markOnline
    // calls and, if the user still has a second tab open, no markOffline
    // call at all until the last one closes.
    presence.markOnline(userA); // tab 1 connects
    presence.markOnline(userA); // tab 2 connects
    expect(presence.isOnline(userA)).toBe(true);

    // tab 1 closes - server determines tab 2 is still connected and does
    // NOT emit an offline event, so nothing is called here either.
    expect(presence.isOnline(userA)).toBe(true);

    // tab 2 (the last one) closes - server emits exactly one offline event.
    presence.markOffline(userA);
    expect(presence.isOnline(userA)).toBe(false);
  });

  test("reset clears both online state and delta tracking for a fresh connection", () => {
    presence.markOnline(userA);
    presence.reset();

    expect(presence.isOnline(userA)).toBe(false);

    // After reset, a snapshot can seed userA again - proving the earlier
    // delta isn't still blocking it from being (re-)applied.
    presence.applySnapshot([userA]);
    expect(presence.isOnline(userA)).toBe(true);
  });
});
