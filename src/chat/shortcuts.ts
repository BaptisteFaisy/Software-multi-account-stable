type ChatHoverShortcutEvent = Pick<
  KeyboardEvent,
  "key" | "code" | "repeat" | "isComposing" | "shiftKey" | "ctrlKey" | "altKey" | "metaKey"
> & Partial<Pick<KeyboardEvent, "target">>;

type EditableShortcutTarget = {
  isContentEditable?: boolean;
  closest?: (selector: string) => unknown;
};

export const chatShortcutTargetIsEditable = (target: unknown): boolean => {
  if (!target || typeof target !== "object") return false;
  const element = target as EditableShortcutTarget;
  if (element.isContentEditable) return true;
  return (
    typeof element.closest === "function" &&
    !!element.closest(
      "input, textarea, select, [contenteditable='true'], [contenteditable='plaintext-only']",
    )
  );
};

export type ChatHoverShortcutAction = "close-chat" | "close-chat-and-discussion";

export const chatHoverShortcutAction = (
  event: ChatHoverShortcutEvent,
): ChatHoverShortcutAction | null => {
  if (
    event.repeat ||
    event.isComposing ||
    event.shiftKey ||
    event.ctrlKey ||
    event.altKey ||
    event.metaKey ||
    chatShortcutTargetIsEditable(event.target)
  ) {
    return null;
  }

  if (event.key === "Delete" || event.code === "Delete") {
    return "close-chat-and-discussion";
  }
  if (event.key === "Backspace" || event.code === "Backspace") {
    return "close-chat";
  }
  return null;
};
