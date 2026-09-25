import { observer } from "mobx-react";
import { useTranslation } from "react-i18next";
import type Message from "~/models/Message";
import { DropdownMenu } from "~/components/Menu/DropdownMenu";
import { OverflowMenuButton } from "~/components/Menu/OverflowMenuButton";
import { useMessageMenuAction } from "~/hooks/useMessageMenuAction";

type Props = {
  /** The message to associate with the menu */
  message: Message;
  /** CSS class name */
  className?: string;
  /** Callback when "Edit" is selected in the menu */
  onEdit: () => void;
  /** Optional callback for after the message has been deleted */
  onDelete?: () => void;
};

/**
 * The overflow-button route to a message's actions. MessageContextMenu offers
 * the same actions via long-press/right-click; both are built from
 * useMessageMenuAction so they stay identical.
 */
function MessageMenu({ message, onEdit, onDelete, className }: Props) {
  const { t } = useTranslation();
  const action = useMessageMenuAction({ message, onEdit, onDelete });

  return (
    <DropdownMenu
      action={action}
      align="end"
      ariaLabel={t("Message options")}
      modal={false}
    >
      <OverflowMenuButton className={className} />
    </DropdownMenu>
  );
}

export default observer(MessageMenu);
