import { ChannelType } from "~/models/Channel";
import stores from "~/stores";

describe("Channel call fields", () => {
  const channels = stores.channels;

  const baseFields = {
    name: "General",
    type: ChannelType.Group,
    memberIds: [],
  };

  beforeEach(() => {
    channels.clear();
  });

  test("call fields round-trip from the presenter onto the model", () => {
    const channel = channels.add({
      ...baseFields,
      id: "11111111-1111-1111-1111-111111111111",
      callId: "22222222-2222-2222-2222-222222222222",
      callStartedAt: "2026-09-23T00:00:00.000Z",
      callStartedById: "33333333-3333-3333-3333-333333333333",
    });

    expect(channel.callId).toBe("22222222-2222-2222-2222-222222222222");
    expect(channel.callStartedAt).toBe("2026-09-23T00:00:00.000Z");
    expect(channel.callStartedById).toBe(
      "33333333-3333-3333-3333-333333333333"
    );
    expect(channel.callInProgress).toBe(true);
  });

  test("a channel without call fields reports no call in progress", () => {
    const channel = channels.add({
      ...baseFields,
      id: "11111111-1111-1111-1111-111111111111",
    });

    // Fields absent from the fixture stay unset (undefined); the only
    // contract that matters is that no call is reported.
    expect(channel.callId).toBeFalsy();
    expect(channel.callInProgress).toBe(false);
  });

  test("the call_ended websocket payload clears the call state", () => {
    // What useCallHandlers does on channels.call_ended.
    const channel = channels.add({
      ...baseFields,
      id: "11111111-1111-1111-1111-111111111111",
      callId: "22222222-2222-2222-2222-222222222222",
      callStartedAt: "2026-09-23T00:00:00.000Z",
      callStartedById: "33333333-3333-3333-3333-333333333333",
    });

    channel.updateData({
      callId: null,
      callStartedAt: null,
      callStartedById: null,
    });

    expect(channel.callId).toBeNull();
    expect(channel.callStartedAt).toBeNull();
    expect(channel.callStartedById).toBeNull();
    expect(channel.callInProgress).toBe(false);
  });
});
