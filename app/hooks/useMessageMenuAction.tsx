import { EditIcon, TrashIcon } from "outline-icons";
import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import type Message from "~/models/Message";
import MessageDeleteDialog from "~/components/MessageDeleteDialog";
import { dialogActionFactory } from "~/actions/definitions/common";
import usePolicy from "~/hooks/usePolicy";
import { createAction } from "~/actions";
import { ChatSection } from "~/actions/sections";
import { useMenuAction } from "~/hooks/useMenuAction";

type Options = {
  /** The message the actions apply to */
  message: Message;
  /** Callback when "Edit" is selected */
  onEdit: () => void;
  /** Optional callback for after the message is deleted. Not needed to update
   * the thread - removing it from the store already does that. */
  onDelete?: () => void;
};

/**
 * Builds the edit/delete actions for a chat message, shared by both ways of
 * reaching them: the overflow button (MessageMenu) and long-press or right
 * click (MessageContextMenu). Defined once here so the two triggers can never
 * drift into offering different things.
 *
 * Both actions are author-only (or admin), which the server enforces in
 * policies/message.ts - the visibility checks here mirror that so the menu
 * doesn't offer something the API would refuse.
 */
export function useMessageMenuAction({ message, onEdit, onDelete }: Options) {
  const { t } = useTranslation();
  const can = usePolicy(message);

  const actions = useMemo(
    () => [
      createAction({
        name: `${t("Edit")}…`,
        icon: <EditIcon />,
        section: ChatSection,
        visible: can.update,
        perform: onEdit,
      }),
      dialogActionFactory({
        analyticsName: "Delete message",
        section: ChatSection,
        name: (tt) => `${tt("Delete")}…`,
        title: (tt) => tt("Delete message"),
        content: () => (
          <MessageDeleteDialog message={message} onSubmit={onDelete} />
        ),
        icon: <TrashIcon />,
        keywords: "trash",
        dangerous: true,
        stopEvent: true,
        visible: ({ stores }) => stores.policies.abilities(message.id).delete,
      }),
    ],
    [t, message, can.update, onEdit, onDelete]
  );

  return useMenuAction(actions);
}
