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
 * Confirms leaving a group. Worth a confirmation rather than a bare menu
 * item: nobody can add themselves back, so this is one-way until somebody
 * still inside brings them in again.
 */
function ChannelLeaveDialog({ channel, onSubmit }: Props) {
  const { channels } = useStores();
  const { t } = useTranslation();

  const handleSubmit = async () => {
    try {
      await channels.leave(channel.id);
      onSubmit?.();
    } catch (err) {
      toast.error(errToString(err));
    }
  };

  return (
    <ConfirmationDialog
      onSubmit={handleSubmit}
      submitText={t("Leave")}
      savingText={`${t("Leaving")}…`}
      danger
    >
      <Text as="p" type="secondary">
        <Trans>
          You'll stop receiving messages here and it will disappear from your
          list. You can't rejoin on your own - someone still in the
          conversation would have to add you back.
        </Trans>
      </Text>
    </ConfirmationDialog>
  );
}

export default observer(ChannelLeaveDialog);
