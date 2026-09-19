import { action } from "mobx";
import { observer } from "mobx-react";
import { PlaneIcon } from "outline-icons";
import * as React from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import styled from "styled-components";
import { v4 as uuidv4 } from "uuid";
import { s } from "@shared/styles";
import type { ProsemirrorData } from "@shared/types";
import type { Editor as SharedEditor } from "~/editor";
import NudeButton from "~/components/NudeButton";
import useCurrentUser from "~/hooks/useCurrentUser";
import useStores from "~/hooks/useStores";
import Message from "~/models/Message";
import MessageEditor from "./MessageEditor";

type Props = {
  /** The channel to post the message into. */
  channelId: string;
};

/**
 * A minimal chat message composer - unlike CommentForm, there is no draft
 * persisted against a document, no comment-thread lifecycle to manage, and
 * no "delete the thread if empty on blur" behavior, since none of that
 * applies to a standalone chat message.
 */
function Composer({ channelId }: Props) {
  const { t } = useTranslation();
  const { messages } = useStores();
  const user = useCurrentUser();
  const formRef = React.useRef<HTMLFormElement>(null);
  const editorRef = React.useRef<SharedEditor>(null);
  const [draft, setDraft] = React.useState<ProsemirrorData | undefined>();
  // Incremented after every send (optimistic, so this happens immediately -
  // not after the server round trip) to force MessageEditor to fully
  // remount, via the `key` below - a guaranteed reset of its internal
  // ProseMirror state. An earlier version instead pushed a fresh `value`
  // prop through the editor's own re-sync path (componentDidUpdate in
  // app/editor/index.tsx) to clear it after sending; confirmed by hand in
  // a real browser that this did not reliably work - the just-sent
  // message's text was left sitting in the composer, still live and
  // editable, even though the send itself succeeded. Remounting sidesteps
  // whatever the exact timing issue was rather than continuing to
  // patch around it.
  const [composerKey, setComposerKey] = React.useState(0);

  const handleChange = (
    getValue: (asString: boolean, trim: boolean) => ProsemirrorData
  ) => {
    const text = getValue(true, true);
    setDraft(text ? getValue(false, true) : undefined);
  };

  const handleSave = () => {
    formRef.current?.dispatchEvent(
      new Event("submit", { cancelable: true, bubbles: true })
    );
  };

  const handleSubmit = action((event: React.FormEvent) => {
    event.preventDefault();

    if (!draft) {
      return;
    }

    const data = draft;
    // Clearing synchronously (not after the request resolves) is the point
    // of this rewrite - the composer used to wait on the full round trip
    // before either the sent message appeared or the input cleared, which
    // is what actually read as "laggy," not network speed itself.
    setDraft(undefined);
    setComposerKey((key) => key + 1);

    // Optimistic render, same convention CommentForm's handleCreateReply
    // already uses: build the model client-side with a generated id, add it
    // to the store immediately so it appears in the thread this frame, then
    // persist in the background and reconcile the same row when the
    // response arrives. `id` is assigned after construction rather than in
    // the constructor fields so Model's `isNew = !this.id` still comes out
    // true here - that's what routes save() to a create call below instead
    // of an update.
    const message = new Message(
      {
        channelId,
        data,
        createdAt: new Date().toISOString(),
        editedAt: null,
        parentMessageId: null,
      },
      messages
    );
    message.id = uuidv4();
    message.createdById = user.id;
    message.createdBy = user;
    messages.add(message);

    message.save({ id: message.id, channelId, data }).catch(() => {
      messages.remove(message.id);
      toast.error(t("Error sending message"));
    });
  });

  return (
    <Form ref={formRef} onSubmit={handleSubmit}>
      <EditorArea>
        <MessageEditor
          key={composerKey}
          ref={editorRef}
          onChange={handleChange}
          onSave={handleSave}
          placeholder={t("Send a message…")}
          autoFocus
        />
      </EditorArea>
      <SendButton type="submit" disabled={!draft} aria-label={t("Send")}>
        <PlaneIcon />
      </SendButton>
    </Form>
  );
}

const EditorArea = styled.div`
  flex: 1;
  min-width: 0;

  /* Deliberately NOT a scroll container, and not height-capped.
   *
   * Capping it requires overflow-y: auto, which makes this a scroll container
   * with zero scroll range whenever the draft is short - the exact condition
   * that makes iOS decline to target an element and pan the page instead
   * (the same bug MessageListInner exists to prevent). touch-action: none on
   * the Form cannot block that; Safari's viewport pan ignores touch-action.
   *
   * MessageListInner's +1px trick doesn't transfer here either: it relies on
   * a definite parent height for the percentage to resolve against, and this
   * element's height is content-driven. So the composer grows unbounded
   * instead - a long draft squeezes the thread, which is a far milder
   * failure than the whole interface coming loose. */
`;

const SendButton = styled(NudeButton)`
  flex-shrink: 0;
  align-self: flex-end;
  color: ${s("accent")};

  &:disabled {
    opacity: 0.4;
    cursor: default;
  }
`;

const Form = styled.form`
  display: flex;
  align-items: flex-end;
  gap: 8px;
  border-top: 1px solid ${s("inputBorder")};
  padding: 8px 16px;

  /* iOS Safari ignores the interactive-widget=resizes-content declared in
   * the viewport meta, so with the keyboard open the page behind the (fixed)
   * chat scene stays full height and can be rubber-banded - a drag starting
   * here used to shift the whole scene. Chat's Viewport now refuses pan
   * gestures scene-wide, making this redundant, but it's kept explicit: this
   * is the element a user actually drags, and it's the one place where the
   * rule must not be relaxed. Safe only because the composer has no scroll
   * region of its own - revisit if it grows a max-height and scrolls. */
  touch-action: none;
`;

export default observer(Composer);
