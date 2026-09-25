import { observer } from "mobx-react";
import { useTranslation, Trans } from "react-i18next";
import { toast } from "sonner";
import { errToString } from "@shared/utils/error";
import type Channel from "~/models/Channel";
import ConfirmationDialog from "~/components/ConfirmationDialog";
import Text from "~/components/Text";
import useStores from "~/hooks/useStores";

type Props = {
  channel: Channel;
  onSubmit?: () => void;
};

/**
 * Confirms removing a conversation from your own list. Worth being explicit
 * in the copy that this is not the destructive thing the word "delete"
 * usually implies here - no messages are removed and the other participant
 * keeps their copy either way.
 */
function ChannelDeleteDialog({ channel, onSubmit }: Props) {
  const { channels } = useStores();
  const { t } = useTranslation();

  const handleSubmit = async () => {
    try {
      await channels.hide(channel.id);
      onSubmit?.();
    } catch (err) {
      toast.error(errToString(err));
    }
  };

  return (
    <ConfirmationDialog
      onSubmit={handleSubmit}
      submitText={t("Delete")}
      savingText={`${t("Deleting")}…`}
      danger
    >
      <Text as="p" type="secondary">
        <Trans>
          This removes the conversation from your list only. No messages are
          deleted, the other people in it keep their copy, and it will come
          back here if someone sends a new message.
        </Trans>
      </Text>
    </ConfirmationDialog>
  );
}

export default observer(ChannelDeleteDialog);
