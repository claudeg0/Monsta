import type { History } from "history";
import type Channel from "~/models/Channel";
import type DialogsStore from "~/stores/DialogsStore";
import { chatPath } from "~/utils/routeHelpers";
import NewConversationDialog from "./components/NewConversationDialog";

/**
 * Opens the "New message" modal, shared by the channel rail's empty-state
 * CTA and the Chat scene's header action - both need to land the viewer in
 * the newly-created (or existing, for a de-duplicated DM) channel and close
 * the modal the same way, so this is one place rather than two.
 *
 * @param dialogs the DialogsStore to open the modal on
 * @param history the router history to navigate with once created
 * @param t the translation function
 */
export function openNewConversation(
  dialogs: DialogsStore,
  history: History,
  t: (key: string) => string
) {
  dialogs.openModal({
    title: t("New message"),
    content: (
      <NewConversationDialog
        onCreated={(channel: Channel) => {
          dialogs.closeAllModals();
          history.push(chatPath(channel.id));
        }}
      />
    ),
  });
}
