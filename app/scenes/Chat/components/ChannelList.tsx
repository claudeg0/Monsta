import { observer } from "mobx-react";
import { CameraIcon } from "outline-icons";
import * as React from "react";
import { useTranslation } from "react-i18next";
import { useHistory } from "react-router-dom";
import styled from "styled-components";
import { s } from "@shared/styles";
import type Channel from "~/models/Channel";
import { ChannelType } from "~/models/Channel";
import { Avatar } from "~/components/Avatar";
import Button from "~/components/Button";
import Flex from "~/components/Flex";
import Text from "~/components/Text";
import Tooltip from "~/components/Tooltip";
import useCurrentUser from "~/hooks/useCurrentUser";
import EventBoundary from "@shared/components/EventBoundary";
import useStores from "~/hooks/useStores";
import ChannelContextMenu from "~/menus/ChannelContextMenu";
import ChannelMenu from "~/menus/ChannelMenu";
import { chatPath } from "~/utils/routeHelpers";
import { joinCall } from "../joinCall";
import { openNewConversation } from "../openNewConversation";

type Props = {
  /** Whether the users referenced by direct-message channels are loading. */
  isLoadingUsers: boolean;
  /** The currently-open channel, if any - highlighted in the list. */
  selectedChannelId?: string;
  /** Called when the user picks a channel to open. */
  onSelectChannel: (channel: Channel) => void;
};

/**
 * Returns the other participant's user id for a `dm` channel - a DM's
 * display name/presence is always derived from them, never stored on the
 * channel itself.
 */
function useOtherParticipant(channel: Channel) {
  const { users } = useStores();
  const currentUser = useCurrentUser();
  const otherUserId = channel.memberIds.find((id) => id !== currentUser.id);
  return otherUserId ? users.get(otherUserId) : undefined;
}

/**
 * An observer in its own right, not just a child of one. It reads
 * `users.get(...)` via useOtherParticipant, and the users store is populated
 * by a fetch that resolves *after* this first renders. ChannelList doesn't
 * read that store, so without its own observer here nothing re-renders when
 * the fetch lands and the row stays on its placeholder name until something
 * unrelated forces a repaint - which is why it used to need a page refresh.
 */
const ChannelListItem = observer(function ChannelListItem_({
  channel,
  isLoadingUsers,
  isSelected,
  onSelect,
  onDelete,
}: {
  channel: Channel;
  isLoadingUsers: boolean;
  isSelected: boolean;
  onSelect: () => void;
  onDelete: () => void;
}) {
  const { t } = useTranslation();
  const { callStore, channels, chatPresence } = useStores();
  const currentUser = useCurrentUser();
  const otherUser = useOtherParticipant(channel);

  const handleJoinCall = (event: React.MouseEvent) => {
    // Deliberately not stopping propagation - the row's own onSelect (open
    // the conversation) is worth doing too, not instead.
    event.preventDefault();
    void joinCall({ channels, callStore }, channel.id);
  };

  const isDirectMessage = channel.type === ChannelType.DirectMessage;
  const isLoadingOtherUser =
    isDirectMessage && !otherUser && isLoadingUsers;
  const title = isDirectMessage
    ? (otherUser?.name ??
      (isLoadingOtherUser ? t("Loading…") : t("Unknown user")))
    : (channel.name ?? t("Unnamed group"));

  // Per the product decision: DMs get a per-user online dot, group
  // channels get a small online count rather than one dot per member -
  // a 3-person team doesn't need more than that yet.
  const onlineCount = React.useMemo(() => {
    if (isDirectMessage) {
      return 0;
    }
    return channel.memberIds.filter(
      (id) => id !== currentUser.id && chatPresence.isOnline(id)
    ).length;
  }, [channel.memberIds, chatPresence, currentUser.id, isDirectMessage]);

  return (
    <ChannelContextMenu channel={channel} onDelete={onDelete}>
      <Item $selected={isSelected} onClick={onSelect}>
        <Flex align="center" gap={8}>
          <AvatarWrapper>
          {otherUser ? (
            <Avatar model={otherUser} />
          ) : (
            <GroupAvatarPlaceholder>{title[0]}</GroupAvatarPlaceholder>
          )}
          {isDirectMessage && otherUser && chatPresence.isOnline(otherUser.id) && (
            <OnlineDot />
          )}
        </AvatarWrapper>
        <Flex column>
          <Text weight={channel.isUnread ? "bold" : undefined} size="small">
            {title}
          </Text>
          {!isDirectMessage && onlineCount > 0 && (
            <Text size="xsmall" type="tertiary">
              {t("{{ count }} online", { count: onlineCount })}
            </Text>
          )}
        </Flex>
        {channel.callInProgress && (
          <Tooltip content={t("Join call")}>
            <CallBadge
              onClick={handleJoinCall}
              aria-label={t("Join call")}
            >
              <CameraIcon size={16} />
            </CallBadge>
          </Tooltip>
        )}
        {channel.isUnread && (
          <UnreadBadge aria-label={t("{{ count }} unread", {
            count: channel.unreadCount,
          })}>
            {channel.unreadCount > 99 ? "99+" : channel.unreadCount}
          </UnreadBadge>
        )}
          {/* Stops opening the menu from also selecting the conversation
           * behind it, since the whole row is a click target. */}
          <EventBoundary>
            <ChannelActions>
              <ChannelMenu channel={channel} onDelete={onDelete} />
            </ChannelActions>
          </EventBoundary>
        </Flex>
      </Item>
    </ChannelContextMenu>
  );
});

function ChannelList({
  isLoadingUsers,
  selectedChannelId,
  onSelectChannel,
}: Props) {
  const { t } = useTranslation();
  const { channels, dialogs } = useStores();
  const history = useHistory();

  const handleSelect = (channel: Channel) => {
    onSelectChannel(channel);
    if (channel.isUnread) {
      void channels.markRead(channel.id);
    }
  };

  const handleDelete = (channel: Channel) => {
    // Hiding the conversation you're currently reading would otherwise leave
    // the thread pane showing a channel that's no longer in the list.
    if (channel.id === selectedChannelId) {
      history.push(chatPath());
    }
  };

  const handleNewConversation = () => {
    openNewConversation(dialogs, history, t);
  };

  if (channels.orderedData.length === 0) {
    return (
      // Matches the pattern used for Search's zero-results state
      // (Centered column + Text type="secondary"), plus a CTA button -
      // there's nothing to click through to otherwise, unlike a search
      // that can just be retried with different terms.
      <EmptyState column align="center" justify="center" gap={12}>
        <Text type="secondary" size="small">
          {t("No conversations yet")}
        </Text>
        <Button onClick={handleNewConversation}>{t("New message")}</Button>
      </EmptyState>
    );
  }

  return (
    <List>
      {channels.orderedData.map((channel) => (
        <ChannelListItem
          key={channel.id}
          channel={channel}
          isLoadingUsers={isLoadingUsers}
          isSelected={channel.id === selectedChannelId}
          onSelect={() => handleSelect(channel)}
          onDelete={() => handleDelete(channel)}
        />
      ))}
    </List>
  );
}

const List = styled.div`
  display: flex;
  flex-direction: column;
`;

const EmptyState = styled(Flex)`
  height: 100%;
  padding: 24px;
  text-align: center;
`;

const Item = styled.div<{ $selected: boolean }>`
  padding: 8px 16px;
  cursor: pointer;
  background: ${(props) => (props.$selected ? s("sidebarActiveBackground") : "transparent")};

  &:hover {
    background: ${s("sidebarActiveBackground")};
  }
`;

const AvatarWrapper = styled.div`
  position: relative;
  flex-shrink: 0;
`;

const ChannelActions = styled.div`
  flex-shrink: 0;
  opacity: 0;
  transition: opacity 100ms ease;

  ${Item}:hover &,
  &:focus-within {
    opacity: 1;
  }

  /* No hover to reveal it on touch, where this is the only way to reach the
   * menu at all - right click is desktop-only. */
  @media (hover: none) {
    opacity: 1;
  }
`;

const GroupAvatarPlaceholder = styled.div`
  width: 24px;
  height: 24px;
  border-radius: 50%;
  background: ${s("sidebarBackground")};
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 12px;
  text-transform: uppercase;
`;

/**
 * Deliberately not the accent colour: the unread badge already uses it, and
 * two accent-coloured indicators on the same row - one on the avatar, one at
 * the end - read as the same signal in two places rather than two different
 * signals. Green is the conventional presence colour and needs no legend.
 */
const OnlineDot = styled.div`
  position: absolute;
  bottom: -1px;
  right: -1px;
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: #30a46c;
  border: 2px solid ${s("background")};
`;

const UnreadBadge = styled.div`
  margin-left: auto;
  flex-shrink: 0;
  min-width: 18px;
  height: 18px;
  padding: 0 5px;
  border-radius: 9px;
  background: ${s("accent")};
  color: ${s("white")};
  font-size: 11px;
  font-weight: 600;
  line-height: 18px;
  text-align: center;
`;

/**
 * The same green as OnlineDot, not the accent colour - this signals "call
 * live," the same kind of thing presence does, not an unread count (which
 * does use accent, immediately to its right).
 */
const CallBadge = styled.button`
  margin-left: auto;
  flex-shrink: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  width: 20px;
  height: 20px;
  padding: 0;
  border: none;
  border-radius: 50%;
  background: #30a46c;
  color: ${s("white")};
  cursor: pointer;
`;

export default observer(ChannelList);
