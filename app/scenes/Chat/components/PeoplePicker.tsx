import { observer } from "mobx-react";
import * as React from "react";
import { useTranslation } from "react-i18next";
import styled from "styled-components";
import type User from "~/models/User";
import ArrowKeyNavigation from "~/components/ArrowKeyNavigation";
import { Avatar, AvatarSize } from "~/components/Avatar";
import Empty from "~/components/Empty";
import Input from "~/components/Input";
import Scrollable from "~/components/Scrollable";
import { ListItem } from "~/components/Sharing/components/ListItem";
import useCurrentUser from "~/hooks/useCurrentUser";
import useStores from "~/hooks/useStores";
import useThrottledCallback from "~/hooks/useThrottledCallback";

type Props = {
  /** Currently-selected user ids. */
  selectedIds: string[];
  /** Called with a user's id when they're picked from the suggestions. */
  onAdd: (userId: string) => void;
  /** Called with a user's id when they're removed from the selection. */
  onRemove: (userId: string) => void;
  /**
   * Hides the chips for already-selected people while still excluding them
   * from the suggestions. For "add someone to this group", the selected ids
   * are the existing members - showing them as removable chips would offer a
   * remove action that doesn't exist.
   */
  hideSelected?: boolean;
};

/**
 * A lean fork of the sharing flow's people-picker shell (ArrowKeyNavigation
 * + ListItem + Avatar - all genuinely generic), not a reuse of
 * Sharing/components/Suggestions.tsx itself. That component bakes in
 * document/collection membership filtering, group suggestions, and an
 * "invite this email to the workspace" fallback - none of which apply
 * here, since a chat participant must already be an existing team member.
 */
function PeoplePicker({
  selectedIds,
  onAdd,
  onRemove,
  hideSelected = false,
}: Props) {
  const { t } = useTranslation();
  const { users } = useStores();
  const currentUser = useCurrentUser();
  const [query, setQuery] = React.useState("");

  const excludeIds = React.useMemo(
    () => [currentUser.id, ...selectedIds],
    [currentUser.id, selectedIds]
  );

  const fetchByQuery = useThrottledCallback(
    (searchQuery: string) => {
      void users.fetchPage({ query: searchQuery });
    },
    250,
    undefined,
    { leading: true }
  );

  React.useEffect(() => {
    fetchByQuery(query);
  }, [query, fetchByQuery]);

  const selected = selectedIds
    .map((id) => users.get(id))
    .filter(Boolean) as User[];
  const suggestions = users.forChatPicker(excludeIds, query);

  return (
    <Container>
      {!hideSelected && selected.length > 0 && (
        <SelectedList>
          {selected.map((user) => (
            <Chip key={user.id} onClick={() => onRemove(user.id)}>
              <Avatar model={user} size={AvatarSize.Small} />
              {user.name}
              <RemoveHint>×</RemoveHint>
            </Chip>
          ))}
        </SelectedList>
      )}
      <Input
        placeholder={t("Search people…")}
        value={query}
        onChange={(event: React.ChangeEvent<HTMLInputElement>) =>
          setQuery(event.target.value)
        }
      />
      <Scrollable style={{ maxHeight: 240 }}>
        <ArrowKeyNavigation aria-label={t("Suggestions")} items={suggestions}>
          {() => [
            ...suggestions.map((user) => (
              <ListItem
                keyboardNavigation
                key={user.id}
                title={user.name}
                subtitle={user.email}
                image={<Avatar model={user} size={AvatarSize.Medium} />}
                onClick={() => onAdd(user.id)}
                onKeyDown={(ev: React.KeyboardEvent) => {
                  if (ev.key === "Enter") {
                    ev.preventDefault();
                    onAdd(user.id);
                  }
                }}
              />
            )),
            suggestions.length === 0 && (
              <Empty key="empty">{t("No matches")}</Empty>
            ),
          ]}
        </ArrowKeyNavigation>
      </Scrollable>
    </Container>
  );
}

const Container = styled.div`
  display: flex;
  flex-direction: column;
  gap: 8px;
`;

const SelectedList = styled.div`
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
`;

const Chip = styled.button`
  display: inline-flex;
  align-items: center;
  gap: 4px;
  border: none;
  border-radius: 16px;
  padding: 2px 8px 2px 2px;
  background: rgba(0, 0, 0, 0.05);
  cursor: pointer;
  font-size: 13px;
`;

const RemoveHint = styled.span`
  opacity: 0.5;
`;

export default observer(PeoplePicker);
