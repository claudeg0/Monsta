import { observer } from "mobx-react";
import * as React from "react";
import { basicExtensions } from "@shared/editor/nodes";
import CodeBlock from "@shared/editor/nodes/CodeBlock";
import CodeFence from "@shared/editor/nodes/CodeFence";
import HardBreak from "@shared/editor/nodes/HardBreak";
import Mention from "@shared/editor/nodes/Mention";
import type { Props as EditorProps } from "~/components/Editor";
import Editor from "~/components/Editor";
import type { Editor as SharedEditor } from "~/editor";
import ClipboardTextSerializer from "~/editor/extensions/ClipboardTextSerializer";
import EmojiMenuExtension from "~/editor/extensions/EmojiMenu";
import Keys from "~/editor/extensions/Keys";
import MentionMenuExtension from "~/editor/extensions/MentionMenu";
import PasteHandler from "~/editor/extensions/PasteHandler";
import PreventTab from "~/editor/extensions/PreventTab";
import SmartText from "~/editor/extensions/SmartText";
import UpArrowAtStart from "~/editor/extensions/UpArrowAtStart";
import useCurrentUser from "~/hooks/useCurrentUser";

// A near-identical fork of CommentEditor.tsx, not a reuse of it - that file
// pulls in the `Comment` mark via `withComments(basicExtensions)`, which
// anchors a comment thread to a highlighted range in a *document's own*
// body (onCreateCommentMark/onClickCommentMark/onOpenCommentsSidebar - all
// document-comment-sidebar-specific). A chat message never has an anchored
// comment applied to it, so that mark is irrelevant baggage here. Mention
// is kept directly (it's what CommentEditor's withComments() call actually
// wanted for this purpose) - everything else below is copied as-is since
// it genuinely is generic, editor-level behavior.
const extensions = [
  Mention,
  ...basicExtensions,
  CodeBlock,
  CodeFence,
  HardBreak,
  SmartText,
  PasteHandler,
  ClipboardTextSerializer,
  EmojiMenuExtension,
  MentionMenuExtension,
  UpArrowAtStart,
  PreventTab,
  // Keys binds Mod-Enter to onSave, which is the only keyboard send now that
  // plain Enter inserts a newline instead. SendOnEnter (the extension that
  // used to bind it) is deliberately not registered here - sending is an
  // explicit button press, so that Enter can do what it does in every other
  // multi-line field.
  Keys,
];

type MessageEditorProps = EditorProps & {
  /** Callback when user presses up arrow at the start of the editor */
  onUpArrowAtStart?: () => void;
};

const MessageEditor = (
  props: MessageEditorProps,
  ref: React.RefObject<SharedEditor>
) => {
  const user = useCurrentUser({ rejectOnEmpty: false });

  return (
    <Editor extensions={extensions} userId={user?.id} {...props} ref={ref} />
  );
};

export default observer(React.forwardRef(MessageEditor));
