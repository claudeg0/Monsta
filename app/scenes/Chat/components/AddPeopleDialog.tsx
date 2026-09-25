import { observer } from "mobx-react";
import * as React from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { errToString } from "@shared/utils/error";
import type Channel from "~/models/Channel";
import Flex from "~/components/Flex";
import Text from "~/components/Text";
import useStores from "~/hooks/useStores";
import PeoplePicker from "./PeoplePicker";

type Props = {
  channel: Channel;
  onSubmit?: () => void;
};

/**
 * Adds people to an existing group. Reuses the same picker the new-group flow
 * uses, but adds each person immediately on selection rather than collecting
 * a list behind a submit button - there's no draft state worth managing here,
 * and each add is independently useful.
 */
function AddPeopleDialog({ channel, onSubmit }: Props) {
  const { t } = useTranslation();
  const { channels } = useStores();
  const [isAdding, setAdding] = React.useState(false);

  const handleAdd = async (userId: string) => {
    if (isAdding) {
      return;
    }

    setAdding(true);
    try {
      await channels.addUser(channel.id, userId);
      onSubmit?.();
    } catch (err) {
      toast.error(errToString(err));
    } finally {
      setAdding(false);
    }
  };

  return (
    <Flex column gap={12}>
      <Text type="secondary" size="small">
        {t("Anyone you add can see the whole conversation history.")}
      </Text>
      <PeoplePicker
        hideSelected
        selectedIds={channel.memberIds}
        onAdd={handleAdd}
        onRemove={() => undefined}
      />
    </Flex>
  );
}

export default observer(AddPeopleDialog);
