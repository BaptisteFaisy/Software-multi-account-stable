import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { chatHoverShortcutAction } from "../src/chat/shortcuts.ts";

const main = readFileSync(new URL("../src/main.ts", import.meta.url), "utf8");

const deleteEvent = (overrides = {}) => ({
  key: "Delete",
  code: "Delete",
  repeat: false,
  isComposing: false,
  shiftKey: false,
  ctrlKey: false,
  altKey: false,
  metaKey: false,
  ...overrides,
});

test("Suppr ferme le chat avec sa discussion", () => {
  assert.equal(chatHoverShortcutAction(deleteEvent()), "close-chat-and-discussion");
});

test("Retour arriere ferme uniquement le chat", () => {
  assert.equal(
    chatHoverShortcutAction(deleteEvent({ key: "Backspace", code: "Backspace" })),
    "close-chat",
  );
});

test("les raccourcis de chat ignorent le maintien et les modificateurs", () => {
  assert.equal(chatHoverShortcutAction(deleteEvent({ repeat: true })), null);
  assert.equal(chatHoverShortcutAction(deleteEvent({ isComposing: true })), null);
  assert.equal(chatHoverShortcutAction(deleteEvent({ shiftKey: true })), null);
  assert.equal(chatHoverShortcutAction(deleteEvent({ ctrlKey: true })), null);
  assert.equal(chatHoverShortcutAction(deleteEvent({ altKey: true })), null);
  assert.equal(chatHoverShortcutAction(deleteEvent({ metaKey: true })), null);
});

test("Suppr et Retour arriere ne ferment rien pendant la saisie", () => {
  const editableTarget = {
    closest: (selector) => (selector.includes("textarea") ? {} : null),
  };
  assert.equal(chatHoverShortcutAction(deleteEvent({ target: editableTarget })), null);
  assert.equal(
    chatHoverShortcutAction(
      deleteEvent({ key: "Backspace", code: "Backspace", target: editableTarget }),
    ),
    null,
  );
  assert.equal(
    chatHoverShortcutAction(deleteEvent({ target: { isContentEditable: true } })),
    null,
  );
});

test("le chat cible est resolu au point exact de la souris", () => {
  assert.match(main, /document\.elementFromPoint\(lastPointerClientX, lastPointerClientY\)/);
  assert.match(main, /closest<HTMLElement>\("\[data-chat-panel\]"\)/);
  assert.match(main, /const key = expertChatKeyAtPointer\(\)/);
  assert.match(main, /closeExpertChatPane\(pane\)/);
  assert.match(main, /closeExpertChatAndDiscussion\(pane\)/);
});

test("la grille explique visiblement les deux raccourcis de chat", () => {
  assert.match(main, /Retour arrière : fermer/);
  assert.match(main, /Suppr : fermer avec la discussion/);
});
