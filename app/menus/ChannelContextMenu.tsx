import { observer } from "mobx-react";
import type * as React from "react";
import { useTranslation } from "react-i18next";
import type Channel from "~/models/Channel";
import { ContextMenu } from "~/components/Menu/ContextMenu";
import { useChannelMenuAction } from "~/hooks/useChannelMenuAction";

type Props = {
  /** The conversation the menu acts on */
  channel: Channel;
  /** The row that opens the menu on right click */
  children: React.ReactNode;
  /** Called once the conversation has been hidden */
  onDelete?: () => void;
};

/**
 * Right-click menu for a conversation row. Desktop only - the shared
 * ContextMenu deliberately doesn't mount on mobile, where ChannelMenu's
 * overflow button is the way in.
 */
export const ChannelContextMenu = observer(function ChannelContextMenu_({
  channel,
  children,
  onDelete,
}: Props) {
  const { t } = useTranslation();
  const action = useChannelMenuAction({ channel, onDelete });

  return (
    <ContextMenu action={action} ariaLabel={t("Conversation options")}>
      {children}
    </ContextMenu>
  );
});

export default ChannelContextMenu;
