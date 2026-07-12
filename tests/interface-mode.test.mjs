import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const main = readFileSync(new URL("../src/main.ts", import.meta.url), "utf8");
const style = readFileSync(new URL("../src/style.css", import.meta.url), "utf8");

test("la grille multi-chat est l'unique interface de conversation", () => {
  assert.doesNotMatch(
    main,
    /InterfaceMode|interfaceMode|data-interface-mode|setInterfaceMode|loadInterfaceMode/,
  );
  assert.doesNotMatch(main, /codex-switch-terminal\.interface-mode/);
  assert.match(main, /\? renderExpertChatGrid\(\)/);
  assert.match(main, /restoreExpertChats\(\);/);
});

test("le selecteur de mode et ses styles ont ete retires", () => {
  assert.doesNotMatch(style, /\.interface-mode-switch|\.chat-mode-switch|\.expert-mode-switch/);
  assert.doesNotMatch(main, />Simple<\/span>/);
});
