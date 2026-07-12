import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const chatView = readFileSync(new URL("../src/chat/view.ts", import.meta.url), "utf8");
const main = readFileSync(new URL("../src/main.ts", import.meta.url), "utf8");
const chatBackend = readFileSync(new URL("../src-tauri/src/chat.rs", import.meta.url), "utf8");

test("le bandeau d'un chat propose de reprendre une discussion", () => {
  assert.match(chatView, /id="\$\{id\("chatResume"\)\}"/);
  assert.match(chatView, /data-open-discussions/);
  assert.match(chatView, />Reprendre une discussion<\/span>/);
});

test("le bandeau de la grille ouvre la meme liste de discussions", () => {
  assert.match(main, /class="tool-button resume-discussion-button"/);
  assert.match(main, /querySelectorAll<HTMLButtonElement>\("\[data-open-discussions\]"\)/);
});

test("une discussion reprise restaure son environnement et donc sa room", () => {
  assert.match(main, /const activateDiscussionFolder/);
  assert.match(main, /setCurrentWorkspace\(folderPath\)/);
  assert.match(main, /createNewTerminal\([\s\S]*?sessionId,[\s\S]*?folderPath,/);
  assert.match(main, /const persistTerminalDiscussionFolder/);
  assert.match(chatBackend, /move_discussion_for_account/);
  assert.match(chatBackend, /CST_ROOM_ID/);
});

test("un chat refuse clairement un compte sans authentification", () => {
  assert.match(chatBackend, /account_has_auth_tokens\(&account\)/);
  assert.match(chatBackend, /Compte non authentifie/);
});
