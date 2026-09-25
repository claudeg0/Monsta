import type { DailyCall } from "@daily-co/daily-js";
import DailyIframe from "@daily-co/daily-js";
import { observer } from "mobx-react";
import { CameraIcon, OpenIcon } from "outline-icons";
import * as React from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import styled from "styled-components";
import { s, depths } from "@shared/styles";
import { errToString } from "@shared/utils/error";
import Button from "~/components/Button";
import Flex from "~/components/Flex";
import Text from "~/components/Text";
import Tooltip from "~/components/Tooltip";
import useStores from "~/hooks/useStores";

/**
 * Full-screen video call surface. Rendered via portal to document.body so it
 * sits entirely outside the Chat scene's flex/height chain (see
 * CHAT_HANDOFF.md §5 for why that chain is fragile to build into) - it has
 * its own body-scroll lock and its own safe-area padding, and is full-screen
 * at every breakpoint rather than only on mobile.
 *
 * Mounted unconditionally from Chat.tsx; renders nothing while no call is
 * joined. Joining/leaving the Daily room itself is entirely local to this
 * component - CallStore only tracks *that* a call is joined, not the frame.
 */
function CallOverlay() {
  const { t } = useTranslation();
  const { callStore, channels } = useStores();
  const containerRef = React.useRef<HTMLDivElement>(null);
  const frameRef = React.useRef<DailyCall | null>(null);
  const [isConfirmingEnd, setConfirmingEnd] = React.useState(false);
  const [isEnding, setEnding] = React.useState(false);
  const [errorMessage, setErrorMessage] = React.useState<string | null>(null);

  const { isOpen, isJoined, isLastParticipant, channelId, session } =
    callStore;

  // The overlay covers the viewport, but on its own nothing stops the page
  // behind it scrolling in response to touch gestures (iOS in particular) -
  // lock body scroll for exactly as long as the overlay is up.
  React.useEffect(() => {
    if (!isOpen) {
      return;
    }
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = previousOverflow;
    };
  }, [isOpen]);

  React.useEffect(() => {
    if (!isOpen || !session || !containerRef.current) {
      return;
    }

    setErrorMessage(null);
    const frame = DailyIframe.createFrame(containerRef.current, {
      showLeaveButton: false,
      showFullscreenButton: false,
    });
    frameRef.current = frame;

    const updateCount = () => {
      callStore.setParticipantCount(frame.participantCounts().present);
    };

    frame.on("joined-meeting", () => {
      updateCount();
      callStore.markJoined();
    });
    frame.on("participant-joined", updateCount);
    frame.on("participant-left", updateCount);
    frame.on("left-meeting", () => {
      callStore.close();
    });
    frame.on("error", (event) => {
      // Keep the overlay up: Daily renders its own error state in the
      // frame, and the "Open in new tab" link below is the documented
      // escape hatch for the error paths that matter (camera/mic denied,
      // the join-vs-meeting.ended race) - closing here would take that
      // affordance away at the moment it's needed.
      setErrorMessage(
        event?.errorMsg ?? t("The video call could not be started")
      );
    });

    void frame.join({ url: session.url, token: session.token });

    return () => {
      frameRef.current = null;
      void frame.destroy();
    };
    // Deliberately not keyed on the full session object - a re-join (new
    // token, same call) shouldn't tear down and recreate the frame; only a
    // genuinely different call (or open/close) should.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen, session?.id]);

  const handleLeave = () => {
    void frameRef.current?.leave();
  };

  const handleEnd = async () => {
    if (!channelId) {
      return;
    }
    setEnding(true);
    try {
      await channels.endCall(channelId);
      // The channels.call_ended broadcast closes the overlay for everyone,
      // including this tab, once it round-trips - no need to close locally.
    } catch (err) {
      toast.error(errToString(err));
    } finally {
      setEnding(false);
      setConfirmingEnd(false);
    }
  };

  if (!isOpen) {
    return null;
  }

  return createPortal(
    <Container>
      <Header>
        <Flex align="center" gap={8}>
          <CameraIcon />
          {errorMessage ? (
            <Text size="small" type="danger">
              {errorMessage}
            </Text>
          ) : (
            <Text weight="bold">{isJoined ? t("Call") : t("Joining…")}</Text>
          )}
        </Flex>
        {isConfirmingEnd ? (
          <Flex align="center" gap={12}>
            <Text size="small" type="secondary">
              {t("End the call for everyone?")}
            </Text>
            <Button
              onClick={handleEnd}
              disabled={isEnding}
              danger
              type="button"
            >
              {isEnding ? `${t("Ending")}…` : t("End for everyone")}
            </Button>
            <Button
              onClick={() => setConfirmingEnd(false)}
              disabled={isEnding}
              neutral
              type="button"
            >
              {t("Cancel")}
            </Button>
          </Flex>
        ) : (
          <Flex align="center" gap={8}>
            {/* Fallback for the embedded frame failing to get camera/mic
             * (a documented PWA quirk, docs/video-call-plan.md §5) - opens
             * Daily's own hosted room UI in a full browser tab instead. */}
            {session && (
              <Tooltip content={t("Open in new tab")}>
                <OpenInTabLink
                  href={`${session.url}?t=${session.token}`}
                  target="_blank"
                  rel="noreferrer"
                  aria-label={t("Open in new tab")}
                >
                  <OpenIcon />
                </OpenInTabLink>
              </Tooltip>
            )}
            <Button onClick={handleLeave} neutral type="button">
              {t("Leave")}
            </Button>
            {isLastParticipant && (
              <Button
                onClick={() => setConfirmingEnd(true)}
                danger
                type="button"
              >
                {t("End for everyone")}
              </Button>
            )}
          </Flex>
        )}
      </Header>
      <Frame ref={containerRef} />
    </Container>,
    document.body
  );
}

const Container = styled.div`
  position: fixed;
  inset: 0;
  z-index: ${depths.modal};
  background: ${s("background")};
  display: flex;
  flex-direction: column;
  overscroll-behavior: none;
  touch-action: none;

  padding-top: var(--sat);
  padding-right: var(--sar);
  padding-bottom: var(--sab);
  padding-left: var(--sal);
`;

const Header = styled.div`
  flex-shrink: 0;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 12px 16px;
  border-bottom: 1px solid ${s("inputBorder")};
`;

const OpenInTabLink = styled.a`
  display: flex;
  align-items: center;
  justify-content: center;
  width: 24px;
  height: 24px;
  color: ${s("textTertiary")};

  &:hover {
    color: ${s("text")};
  }
`;

const Frame = styled.div`
  flex: 1;
  min-height: 0;

  iframe {
    width: 100%;
    height: 100%;
    border: none;
  }
`;

export default observer(CallOverlay);
