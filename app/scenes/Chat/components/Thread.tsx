import { observer } from "mobx-react";
import { CameraIcon } from "outline-icons";
import * as React from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import styled from "styled-components";
import { s } from "@shared/styles";
import type { ProsemirrorData } from "@shared/types";
import { dateToRelative } from "@shared/utils/date";
import { errToString } from "@shared/utils/error";
import type Message from "~/models/Message";
import { Avatar } from "~/components/Avatar";
import Button from "~/components/Button";
import Flex from "~/components/Flex";
import Text from "~/components/Text";
import useStores from "~/hooks/useStores";
import MessageContextMenu from "~/menus/MessageContextMenu";
import MessageMenu from "~/menus/MessageMenu";
import { PAGINATION_SYMBOL } from "~/stores/base/Store";
import Composer from "./Composer";
import MessageEditor from "./MessageEditor";
import { joinCall } from "../joinCall";

type Props = {
  channelId: string;
};

/**
 * An observer in its own right. Thread only tracks the message *collection*,
 * so a change to a message's own fields - `data` when someone else edits it,
 * or `createdBy` resolving once the users store loads - would otherwise never
 * repaint this row. Editing your own message hides the problem, because local
 * state forces a re-render anyway.
 */
const MessageItem = observer(function MessageItem_({
  message,
}: {
  message: Message;
}) {
  const { t } = useTranslation();
  const [isEditing, setEditing] = React.useState(false);
  const draft = React.useRef<ProsemirrorData | undefined>();

  const handleEditorChange = (
    getValue: (asString: boolean, trim: boolean) => ProsemirrorData
  ) => {
    const text = getValue(true, true);
    draft.current = text ? getValue(false, true) : undefined;
  };

  const handleSaveEdit = async () => {
    // An edit that empties the message is a no-op rather than a delete -
    // deleting is its own explicit, confirmed action in the menu.
    if (!draft.current) {
      setEditing(false);
      return;
    }

    try {
      await message.save({ id: message.id, data: draft.current });
      setEditing(false);
    } catch (err) {
      toast.error(errToString(err));
    }
  };

  const handleCancelEdit = () => {
    draft.current = undefined;
    setEditing(false);
  };

  const row = (
    <MessageRow>
      <Avatar model={message.createdBy} />
      <Flex column style={{ flex: 1, minWidth: 0 }}>
        <Flex align="baseline" gap={6}>
          <Text weight="bold" size="small">
            {message.createdBy.name}
          </Text>
          <Text size="xsmall" type="tertiary">
            {dateToRelative(Date.parse(message.createdAt))}
          </Text>
          {message.isEdited && (
            <Text
              size="xsmall"
              type="tertiary"
              title={message.editedAt ?? undefined}
            >
              {t("(edited)")}
            </Text>
          )}
        </Flex>
        {isEditing ? (
          <>
            <MessageEditor
              autoFocus
              value={message.data}
              onChange={handleEditorChange}
              onSave={handleSaveEdit}
            />
            <Flex gap={12} align="center">
              <EditAction type="button" onClick={handleSaveEdit} $primary>
                {t("Save")}
              </EditAction>
              <EditAction type="button" onClick={handleCancelEdit}>
                {t("Cancel")}
              </EditAction>
            </Flex>
          </>
        ) : (
          <MessageEditor readOnly value={message.data} />
        )}
      </Flex>
      {!isEditing && (
        <MessageActions>
          <MessageMenu message={message} onEdit={() => setEditing(true)} />
        </MessageActions>
      )}
    </MessageRow>
  );

  // While editing, the long-press menu is suppressed - it would fight the
  // text selection the user needs to actually edit with.
  return isEditing ? (
    row
  ) : (
    <MessageContextMenu message={message} onEdit={() => setEditing(true)}>
      {row}
    </MessageContextMenu>
  );
});

function Thread({ channelId }: Props) {
  const { t } = useTranslation();
  const { callStore, channels, messages } = useStores();
  const [isLoadingMore, setLoadingMore] = React.useState(false);
  const [hasMore, setHasMore] = React.useState(true);

  const channelMessages = messages.inChannel(channelId);
  const channel = channels.get(channelId);
  const showCallBanner =
    channel?.callInProgress &&
    !(callStore.isOpen && callStore.channelId === channelId);

  const handleJoinCall = () => {
    void joinCall({ channels, callStore }, channelId);
  };

  // Deliberately keyed on channelId alone - the initial page load for a
  // freshly-opened channel, not a re-fetch on every new message (those
  // arrive live via the messages.create websocket handler and are added to
  // the store directly, not by re-querying this endpoint).
  React.useEffect(() => {
    setHasMore(true);
    void messages.fetchPage({ channelId }).then((res) => {
      const total = res[PAGINATION_SYMBOL]?.total;
      if (total !== undefined) {
        setHasMore(messages.inChannel(channelId).length < total);
      }
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [channelId]);

  // Keep the read cursor current while viewing. New messages arrive live
  // via the messages.create websocket handler, so keying on the newest
  // message id is the "user is caught up" signal - and it is the entire
  // feed for chat-notification suppression: the notification task skips any
  // recipient whose membership.lastReadAt covers the message (see
  // docs/chat-notifications-plan.md). Own messages included - having just
  // sent one, the sender has read it. inChannel() is oldest-first, so the
  // newest message is the last element.
  const newestMessageId = channelMessages[channelMessages.length - 1]?.id;
  React.useEffect(() => {
    if (newestMessageId) {
      void channels.markRead(channelId);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [channelId, newestMessageId]);

  const handleLoadOlder = async () => {
    setLoadingMore(true);
    try {
      const res = await messages.fetchPage({
        channelId,
        offset: channelMessages.length,
      });
      const total = res[PAGINATION_SYMBOL]?.total;
      if (total !== undefined) {
        setHasMore(messages.inChannel(channelId).length < total);
      }
    } finally {
      setLoadingMore(false);
    }
  };

  return (
    <Container column>
      {showCallBanner && (
        <CallBanner align="center" justify="space-between" gap={12}>
          <Flex align="center" gap={8}>
            <CameraIcon />
            <Text size="small" weight="bold">
              {t("Call in progress")}
            </Text>
          </Flex>
          <Button onClick={handleJoinCall}>{t("Join")}</Button>
        </CallBanner>
      )}
      <MessageList>
        <MessageListInner>
          {hasMore && (
            <LoadMore onClick={handleLoadOlder} disabled={isLoadingMore}>
              {isLoadingMore ? t("Loading…") : t("Load earlier messages")}
            </LoadMore>
          )}
          {channelMessages.map((message) => (
            <MessageItem key={message.id} message={message} />
          ))}
        </MessageListInner>
      </MessageList>
      <Composer channelId={channelId} />
    </Container>
  );
}

const Container = styled(Flex)`
  height: 100%;
  min-height: 0;
`;

const CallBanner = styled(Flex)`
  flex-shrink: 0;
  padding: 8px 16px;
  background: ${s("sidebarActiveBackground")};
  border-bottom: 1px solid ${s("inputBorder")};
`;

const MessageList = styled.div`
  flex: 1;

  /* Load-bearing, not defensive: a flex item defaults to min-height: auto,
   * which refuses to shrink below its content. Without this the list stays
   * as tall as every message in it, so overflow-y below never actually has
   * anything to scroll - the element isn't a scroll region at all, and a
   * touch drag chains straight to the document instead, dragging the
   * header and composer along with it. */
  min-height: 0;
  overflow-y: auto;

  /* Keeps momentum at the top/bottom of the list from chaining out to the
   * page even once the region above is correctly bounded - the other half
   * of the same "whole interface moves" symptom on iOS Safari. */
  overscroll-behavior-y: contain;

  /* The one place in the scene allowed to consume a vertical drag - Chat's
   * Viewport refuses the gesture everywhere else. Scoped to this element
   * rather than left to the default so the answer doesn't depend on whether
   * the thread currently happens to overflow: a short thread simply absorbs
   * the drag and does nothing, instead of passing it up to the page. */
  touch-action: pan-y;

  padding: 16px;
`;

const MessageListInner = styled.div`
  /* One spare pixel, and it is load-bearing. iOS only hands a touch to a
   * scroll container that actually has somewhere to scroll; a thread shorter
   * than the list has zero scroll range, so Safari falls back to panning the
   * visual viewport and drags the whole scene. touch-action cannot refuse
   * that - confirmed on device, which reported the rules applied (none/pan-y)
   * with LIST_RANGE 0 and still panned. Keeping a pixel of range makes the
   * list the gesture target at any message count, and the parent's
   * overscroll-behavior stops that pixel chaining onward. Without it the
   * behavior depends on how many messages a thread happens to contain, which
   * is exactly the bug: quiet threads panned, busy ones did not. */
  min-height: calc(100% + 1px);
`;

const MessageRow = styled.div`
  display: flex;
  gap: 8px;
  padding: 4px 0;
`;

const MessageActions = styled.div`
  flex-shrink: 0;
  opacity: 0;
  transition: opacity 100ms ease;

  ${MessageRow}:hover &,
  &:focus-within {
    opacity: 1;
  }

  /* Touch devices have no hover to reveal it, so it stays visible there
   * rather than being unreachable. */
  @media (hover: none) {
    opacity: 1;
  }
`;

const EditAction = styled.button<{ $primary?: boolean }>`
  margin-top: 4px;
  padding: 0;
  background: none;
  border: none;
  font-size: 13px;
  font-weight: ${(props) => (props.$primary ? 600 : 400)};
  color: ${(props) => (props.$primary ? s("accent") : s("textTertiary"))};
  cursor: pointer;

  &:hover {
    ${(props) => (props.$primary ? "" : `color: ${props.theme.text};`)}
  }
`;

const LoadMore = styled.button`
  display: block;
  margin: 0 auto 16px;
  background: none;
  border: none;
  color: ${s("textTertiary")};
  cursor: pointer;

  &:hover {
    color: ${s("text")};
  }
`;

export default observer(Thread);
