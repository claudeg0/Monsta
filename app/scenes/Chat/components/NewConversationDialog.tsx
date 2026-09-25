import { observer } from "mobx-react";
import * as React from "react";
import { useTranslation } from "react-i18next";
import styled from "styled-components";
import { s } from "@shared/styles";
import type Channel from "~/models/Channel";
import { ChannelType } from "~/models/Channel";
import Button from "~/components/Button";
import Flex from "~/components/Flex";
import Input from "~/components/Input";
import Text from "~/components/Text";
import useStores from "~/hooks/useStores";
import PeoplePicker from "./PeoplePicker";

type Props = {
  /** Called once the channel has been created (or an existing DM found). */
  onCreated: (channel: Channel) => void;
};

/**
 * Content for the "New message" modal (opened via dialogs.openModal).
 * DM mode: picking a person replaces the selection, since a DM is always
 * exactly one other participant - not additive like the group picker.
 * Group mode: name + multiple people, minimum viable per the product
 * decision (no avatar/topic/etc. in this pass).
 */
function NewConversationDialog({ onCreated }: Props) {
  const { t } = useTranslation();
  const { channels } = useStores();
  const [type, setType] = React.useState<ChannelType>(ChannelType.DirectMessage);
  const [userIds, setUserIds] = React.useState<string[]>([]);
  const [name, setName] = React.useState("");
  const [isSubmitting, setSubmitting] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  const handleModeChange = (nextType: ChannelType) => {
    setType(nextType);
    // Switching from group to dm with multiple people already picked would
    // be an invalid dm request - clear down to the constraint instead of
    // silently truncating to an arbitrary one of them.
    if (nextType === ChannelType.DirectMessage && userIds.length > 1) {
      setUserIds([]);
    }
  };

  const handleAdd = (userId: string) => {
    setUserIds((current) =>
      type === ChannelType.DirectMessage ? [userId] : [...current, userId]
    );
  };

  const handleRemove = (userId: string) => {
    setUserIds((current) => current.filter((id) => id !== userId));
  };

  const canSubmit =
    type === ChannelType.DirectMessage
      ? userIds.length === 1
      : userIds.length >= 1 && name.trim().length > 0;

  const handleSubmit = async () => {
    if (!canSubmit || isSubmitting) {
      return;
    }

    setSubmitting(true);
    setError(null);
    try {
      // The server already de-duplicates DMs between the same two people
      // (server/routes/api/channels/channels.ts) - creating "again" just
      // returns the existing channel, so no separate check is needed here.
      // `userIds` (and `name` for a group) are create-only input, not
      // fields on the Channel model itself, so they go in the second
      // "options" argument rather than `params`.
      const channel = await channels.create(
        { type },
        {
          userIds,
          ...(type === ChannelType.Group ? { name: name.trim() } : {}),
        }
      );
      onCreated(channel);
    } catch (err) {
      setError(err instanceof Error ? err.message : t("Something went wrong"));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Flex column gap={12}>
      <ModeToggle>
        <ModeButton
          type="button"
          $active={type === ChannelType.DirectMessage}
          onClick={() => handleModeChange(ChannelType.DirectMessage)}
        >
          {t("Direct message")}
        </ModeButton>
        <ModeButton
          type="button"
          $active={type === ChannelType.Group}
          onClick={() => handleModeChange(ChannelType.Group)}
        >
          {t("Group")}
        </ModeButton>
      </ModeToggle>

      {type === ChannelType.Group && (
        <Input
          placeholder={t("Group name")}
          value={name}
          onChange={(event: React.ChangeEvent<HTMLInputElement>) =>
            setName(event.target.value)
          }
        />
      )}

      <PeoplePicker
        selectedIds={userIds}
        onAdd={handleAdd}
        onRemove={handleRemove}
      />

      {error && (
        <Text type="danger" size="small">
          {error}
        </Text>
      )}

      <Flex justify="flex-end">
        <Button onClick={handleSubmit} disabled={!canSubmit || isSubmitting}>
          {isSubmitting
            ? t("Creating…")
            : type === ChannelType.DirectMessage
              ? t("Open conversation")
              : t("Create group")}
        </Button>
      </Flex>
    </Flex>
  );
}

const ModeToggle = styled.div`
  display: flex;
  gap: 4px;
`;

const ModeButton = styled.button<{ $active: boolean }>`
  flex: 1;
  padding: 6px 12px;
  border: 1px solid ${s("inputBorder")};
  border-radius: 6px;
  background: ${(props) => (props.$active ? s("accent") : "transparent")};
  color: ${(props) => (props.$active ? s("white") : s("text"))};
  cursor: pointer;
`;

export default observer(NewConversationDialog);
