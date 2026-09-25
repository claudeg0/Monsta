import { observer } from "mobx-react";
import { useTranslation } from "react-i18next";
import type Channel from "~/models/Channel";
import { DropdownMenu } from "~/components/Menu/DropdownMenu";
import { OverflowMenuButton } from "~/components/Menu/OverflowMenuButton";
import { useChannelMenuAction } from "~/hooks/useChannelMenuAction";

type Props = {
  /** The conversation to associate with the menu */
  channel: Channel;
  /** CSS class name */
  className?: string;
  /** Called once the conversation has been hidden */
  onDelete?: () => void;
};

/**
 * The overflow-button route to a conversation's actions, and the only one on
 * mobile - ChannelContextMenu's right click is desktop-only.
 */
function ChannelMenu({ channel, onDelete, className }: Props) {
  const { t } = useTranslation();
  const action = useChannelMenuAction({ channel, onDelete });

  return (
    <DropdownMenu
      action={action}
      align="end"
      ariaLabel={t("Conversation options")}
      modal={false}
    >
      <OverflowMenuButton className={className} />
    </DropdownMenu>
  );
}

export default observer(ChannelMenu);
