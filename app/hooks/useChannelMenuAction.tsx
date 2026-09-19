import { LogoutIcon, TrashIcon, UserAddIcon } from "outline-icons";
import { useMemo } from "react";
import type Channel from "~/models/Channel";
import { ChannelType } from "~/models/Channel";
import ChannelDeleteDialog from "~/components/ChannelDeleteDialog";
import ChannelLeaveDialog from "~/components/ChannelLeaveDialog";
import AddPeopleDialog from "~/scenes/Chat/components/AddPeopleDialog";
import { dialogActionFactory } from "~/actions/definitions/common";
import { ActionSeparator } from "~/actions";
import { ChatSection } from "~/actions/sections";
import { useMenuAction } from "~/hooks/useMenuAction";

type Options = {
  /** The conversation the actions apply to */
  channel: Channel;
  /** Called once the conversation has been hidden */
  onDelete?: () => void;
};

/**
 * Builds the actions for a conversation in the channel rail, shared by the
 * overflow button (ChannelMenu) and right click (ChannelContextMenu) so the
 * two can't drift apart.
 *
 * No policy check: hiding is per-viewer and touches only the caller's own
 * membership row, so anyone in a conversation may do it to their own copy.
 * The server re-derives that membership from the session rather than
 * trusting anything sent from here.
 */
export function useChannelMenuAction({ channel, onDelete }: Options) {
  const isGroup = channel.type === ChannelType.Group;

  const actions = useMemo(
    () => [
      dialogActionFactory({
        analyticsName: "Add people to conversation",
        section: ChatSection,
        name: (tt) => `${tt("Add people")}…`,
        title: (tt) => tt("Add people"),
        content: () => <AddPeopleDialog channel={channel} />,
        icon: <UserAddIcon />,
        keywords: "invite member participant",
        // Groups only - a dm is exactly two people by definition.
        visible: isGroup,
      }),
      dialogActionFactory({
        analyticsName: "Leave conversation",
        section: ChatSection,
        name: (tt) => `${tt("Leave")}…`,
        title: (tt) => tt("Leave conversation"),
        content: () => (
          <ChannelLeaveDialog channel={channel} onSubmit={onDelete} />
        ),
        icon: <LogoutIcon />,
        keywords: "exit remove",
        // Leaving a dm would strand a one-person channel; hiding it is the
        // exit there. The server rejects it either way.
        visible: isGroup,
        stopEvent: true,
      }),
      ActionSeparator,
      dialogActionFactory({
        analyticsName: "Delete conversation",
        section: ChatSection,
        name: (tt) => `${tt("Delete")}…`,
        title: (tt) => tt("Delete conversation"),
        content: () => (
          <ChannelDeleteDialog channel={channel} onSubmit={onDelete} />
        ),
        icon: <TrashIcon />,
        keywords: "hide remove conversation",
        dangerous: true,
        stopEvent: true,
      }),
    ],
    [channel, isGroup, onDelete]
  );

  return useMenuAction(actions);
}
