import { observer } from "mobx-react";
import { BackIcon, PlusIcon } from "outline-icons";
import * as React from "react";
import { useTranslation } from "react-i18next";
import { useHistory, useRouteMatch } from "react-router-dom";
import styled, { css } from "styled-components";
import { s } from "@shared/styles";
import type Channel from "~/models/Channel";
import Flex from "~/components/Flex";
import Header from "~/components/Header";
import NudeButton from "~/components/NudeButton";
import PageTitle from "~/components/PageTitle";
import Text from "~/components/Text";
import Tooltip from "~/components/Tooltip";
import useMobile from "~/hooks/useMobile";
import { useVisibleViewportVars } from "~/hooks/useVisualViewport";
import useStores from "~/hooks/useStores";
import { chatPath } from "~/utils/routeHelpers";
import ChannelList from "./components/ChannelList";
import Thread from "./components/Thread";
import { openNewConversation } from "./openNewConversation";

// Why this doesn't just render <Scene>: Scene's own root (FillWidth) stacks
// its Header and children in plain block flow with no flex coordination
// and no height of its own - every other scene in this app is fine with
// that because it lets the whole page grow and the browser scroll, which
// is exactly the bug here (the composer scrolls off screen instead of
// staying pinned). Nothing above Scene establishes a definite viewport
// height either: Layout.tsx's own root is `min-height: 100%` deliberately,
// not `height`, for that same page-scrolls-naturally design. So a
// percentage height anywhere in that chain (including an earlier version
// of this file) silently resolves to nothing.
//
// The fix used here doesn't fight that chain or hardcode HEADER_HEIGHT
// (Header is `min-height`, not `height` - it can grow taller than 56px,
// e.g. wrapped content on narrow viewports, and a hardcoded subtraction
// would quietly break again exactly there). Instead this renders Header
// directly inside its own flex column, anchored to a real, ancestor-
// independent height - so Header takes whatever space it actually needs
// and Thread's message list fills exactly what's left, with no assumption
// about the header's size baked in anywhere.
//
// The anchor is `--visible-height` from useVisibleViewportVars
// (app/hooks/useVisualViewport.ts - the same mechanism the iOS mention-menu
// fix uses), not raw `100vh`: on mobile, `vh` units resolve against the
// layout viewport, which does not shrink for the on-screen keyboard, so an
// element sized in raw `vh` would sit partly behind it. Falls back to
// `100dvh` before the hook's first frame runs, then to plain `100vh` for
// environments without dvh support.
function Chat() {
  const { t } = useTranslation();
  const { channels, dialogs, users } = useStores();
  const history = useHistory();
  const match = useRouteMatch<{ channelId?: string }>();
  const channelId = match.params.channelId;
  const isMobile = useMobile();

  useVisibleViewportVars();

  // The scene is pinned to the visible band on mobile (see Viewport), so the
  // page behind it has nothing worth scrolling - but the document is still
  // taller than the visible area whenever the keyboard or an expanded address
  // bar is in play, and iOS will happily drag it. Locking it here is what
  // stops the whole interface being pulled up out of position.
  React.useEffect(() => {
    if (!isMobile) {
      return;
    }

    const root = document.documentElement;
    const { body } = document;
    const previousRoot = root.style.overflow;
    const previousBody = body.style.overflow;

    root.style.overflow = "hidden";
    body.style.overflow = "hidden";

    return () => {
      root.style.overflow = previousRoot;
      body.style.overflow = previousBody;
    };
  }, [isMobile]);

  React.useEffect(() => {
    void channels.fetchPage();
    // Channels only carry member *ids* (see server/presenters/channel.ts) -
    // without this, a DM's other participant renders as "Unknown user"
    // until something else happens to populate the users store (e.g.
    // opening the new-conversation picker, which loads it the same way).
    void users.fetchPage();
  }, [channels, users]);

  const handleSelectChannel = (channel: Channel) => {
    history.push(chatPath(channel.id));
  };

  const handleNewConversation = () => {
    openNewConversation(dialogs, history, t);
  };

  const handleBackToChannels = () => {
    history.push(chatPath());
  };

  // Below the mobile breakpoint (see ~/hooks/useMobile, the same hook
  // Header/SidebarLayout/SplitView already use for this) the two-pane
  // desktop layout doesn't fit - one pane renders at a time instead: the
  // rail on /chat, the open thread on /chat/:channelId, with the header's
  // back button (same `left` slot Document's mobile header uses) as the
  // way back to the rail. Above the breakpoint both panes render as before.
  const showRail = !isMobile || !channelId;
  const showMain = !isMobile || !!channelId;

  return (
    <Viewport column $pinned={isMobile}>
      <PageTitle title={t("Chat")} />
      <Header
        hasSidebar
        title={t("Chat")}
        left={
          isMobile && channelId ? (
            <Tooltip content={t("Back")}>
              <NudeButton onClick={handleBackToChannels} aria-label={t("Back")}>
                <BackIcon />
              </NudeButton>
            </Tooltip>
          ) : undefined
        }
        actions={
          <Tooltip content={t("New message")}>
            <NudeButton onClick={handleNewConversation}>
              <PlusIcon />
            </NudeButton>
          </Tooltip>
        }
      />
      <Body>
        {showRail && (
          <ChannelRail $fullWidth={isMobile}>
            {/* The shared Header's own title never paints here - it renders
             * only once `isScrolled`, and this scene deliberately never
             * scrolls the page - so the full-width mobile list would
             * otherwise be headerless. Matches Modal's mobile title
             * treatment (Text, bold), the app's closest precedent for a
             * full-screen surface's own heading. */}
            {isMobile && (
              <RailHeading>
                <Text as="h2" size="large" weight="bold">
                  {t("Chats")}
                </Text>
              </RailHeading>
            )}
            <ChannelList
              selectedChannelId={channelId}
              onSelectChannel={handleSelectChannel}
            />
          </ChannelRail>
        )}
        {showMain && (
          <Main>
            {channelId ? (
              <Thread channelId={channelId} />
            ) : (
              <EmptyState align="center" justify="center">
                <Text type="tertiary">{t("Select a conversation")}</Text>
              </EmptyState>
            )}
          </Main>
        )}
      </Body>
    </Viewport>
  );
}

const Viewport = styled(Flex)<{ $pinned?: boolean }>`
  /* Not decoration: Layout's Content is a row flex container with
   * justify-content: center, and Flex itself sets neither a width nor
   * flex-grow (flex: initial). Without this the scene is sized shrink-to-fit
   * and centered, leaving live document either side of it - drag those strips
   * and the page scrolls behind the app instead of the message list moving.
   * Every other scene gets this for free from Scene.tsx's FillWidth wrapper;
   * this one opted out of <Scene> (see above) and has to restate it. */
  width: 100%;

  /* var() only accepts one fallback value, so a dvh-then-vh cascade has to
   * be three separate declarations - a browser that doesn't understand a
   * given value treats the whole declaration as invalid and keeps
   * whichever earlier one it does understand, rather than erroring. */
  height: 100vh;
  height: 100dvh;
  height: var(--visible-height, 100dvh);

  /* Header renders its own scroll-shrink effect against window.scrollY,
   * which never fires here since this page itself never scrolls - that's
   * expected, not a bug: the whole point is that only Body's children
   * scroll internally, not the page. */
  overflow: hidden;

  ${(props) =>
    props.$pinned &&
    css`
      /* Anchored to the *visual* viewport rather than sitting in document
       * flow. On iOS the layout viewport keeps its full height when the
       * keyboard opens (and when the address bar is expanded), so the page
       * behind the app is taller than what's on screen and can be dragged -
       * taking the header and composer up out of position with it. Taking
       * the scene out of flow leaves nothing to drag, and --visual-top
       * tracks any panning iOS does on its own (it pans to reveal a focused
       * input) every frame, so the scene stays glued to the visible band
       * instead of being carried off with the page. */
      position: fixed;
      top: var(--visual-top, 0px);
      left: 0;
      right: 0;

      /* A drag starting on the composer has no ancestor with real scrollable
       * overflow to claim it, so the browser bounces the nearest scroll
       * container instead - flashing a scroll indicator down the right edge
       * and shifting the scene a few px before it snaps back. This element is
       * that container (overflow: hidden still makes one), so suppressing the
       * bounce here is what stops the wobble. */
      overscroll-behavior: none;

      /* No pan gestures anywhere in the scene; the message list opts back in
       * for vertical scrolling itself (see Thread's MessageList). Note this
       * is not on its own what keeps the page from being dragged: iOS will
       * still pan the visual viewport when a gesture has nowhere else to go,
       * and touch-action cannot refuse that - see MessageListInner, which
       * removes that condition instead. */
      touch-action: none;
    `}
`;

const Body = styled(Flex)`
  flex: 1;
  min-height: 0;
`;

const ChannelRail = styled.div<{ $fullWidth?: boolean }>`
  width: ${(props) => (props.$fullWidth ? "100%" : "280px")};
  flex-shrink: 0;
  overflow-y: auto;

  /* Only a divider when there's a thread pane to divide from. Rendered
   * full-width and alone it paints a stray vertical line down the right
   * edge of the screen, which reads as a collapsed second pane. */
  ${(props) =>
    props.$fullWidth
      ? ""
      : css`
          border-right: 1px solid ${s("inputBorder")};
        `}
`;

const RailHeading = styled.div`
  /* Aligns with ChannelList's own items, which use the same inline padding. */
  padding: 4px 16px 8px;

  h2 {
    margin: 0;
  }
`;

const Main = styled.div`
  flex: 1;
  min-width: 0;
  min-height: 0;
  display: flex;
  flex-direction: column;
`;

const EmptyState = styled(Flex)`
  flex: 1;
`;

export default observer(Chat);
