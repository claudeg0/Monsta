import { observer } from "mobx-react";
import { useTranslation, Trans } from "react-i18next";
import { toast } from "sonner";
import { errToString } from "@shared/utils/error";
import type Message from "~/models/Message";
import ConfirmationDialog from "~/components/ConfirmationDialog";
import Text from "~/components/Text";

type Props = {
  message: Message;
  onSubmit?: () => void;
};

/**
 * Mirrors CommentDeleteDialog - a chat message has no thread of replies to
 * take down with it (parentMessageId exists but nothing creates one yet), so
 * unlike comments there's only ever the single-message case to confirm.
 */
function MessageDeleteDialog({ message, onSubmit }: Props) {
  const { t } = useTranslation();

  const handleSubmit = async () => {
    try {
      await message.delete();
      onSubmit?.();
    } catch (err) {
      toast.error(errToString(err));
    }
  };

  return (
    <ConfirmationDialog
      onSubmit={handleSubmit}
      submitText={t("I’m sure – Delete")}
      savingText={`${t("Deleting")}…`}
      danger
    >
      <Text as="p" type="secondary">
        <Trans>Are you sure you want to permanently delete this message?</Trans>
      </Text>
    </ConfirmationDialog>
  );
}

export default observer(MessageDeleteDialog);
