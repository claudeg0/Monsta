import { observer } from "mobx-react";
import type * as React from "react";
import { useTranslation } from "react-i18next";
import type Message from "~/models/Message";
import { ContextMenu } from "~/components/Menu/ContextMenu";
import { useMessageMenuAction } from "~/hooks/useMessageMenuAction";

type Props = {
  /** The message the menu acts on */
  message: Message;
  /** The element that opens the menu on long-press or right click */
  children: React.ReactNode;
  /** Callback when "Edit" is selected */
  onEdit: () => void;
  /** Optional callback for after the message has been deleted */
  onDelete?: () => void;
};

/**
 * Wraps a message in a long-press (touch) / right-click (pointer) menu, the
 * same interaction DocumentContextMenu provides for documents. The long-press
 * handling is Radix's, not ours - this is the app's ContextMenu primitive,
 * which is built on @radix-ui/react-context-menu.
 *
 * Offered alongside MessageMenu's overflow button rather than replacing it,
 * so both can be lived with before picking one.
 */
export const MessageContextMenu = observer(function MessageContextMenu_({
  message,
  children,
  onEdit,
  onDelete,
}: Props) {
  const { t } = useTranslation();
  const action = useMessageMenuAction({ message, onEdit, onDelete });

  return (
    <ContextMenu
      action={action}
      ariaLabel={t("Message options")}
    >
      {children}
    </ContextMenu>
  );
});

export default MessageContextMenu;
