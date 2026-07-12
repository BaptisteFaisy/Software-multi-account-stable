import assert from "node:assert/strict";
import test from "node:test";

import {
  CHAT_SIDEBAR_MAX_WIDTH,
  CHAT_SIDEBAR_MIN_WIDTH,
  chatSidebarMaxWidth,
  clampChatSidebarWidth,
  defaultChatSidebarWidth,
} from "../src/chat/sidebar.ts";

test("la barre de conversations conserve les largeurs par defaut existantes", () => {
  assert.equal(defaultChatSidebarWidth(1440), 272);
  assert.equal(defaultChatSidebarWidth(980), 244);
});

test("la largeur redimensionnee reste dans ses bornes", () => {
  assert.equal(clampChatSidebarWidth(-20, 1440), CHAT_SIDEBAR_MIN_WIDTH);
  assert.equal(clampChatSidebarWidth(0, 1440), 0);
  assert.equal(clampChatSidebarWidth(80, 1440), 80);
  assert.equal(clampChatSidebarWidth(900, 1440), CHAT_SIDEBAR_MAX_WIDTH);
  assert.equal(clampChatSidebarWidth(318.6, 1440), 319);
});

test("la barre de conversations peut etre entierement masquee", () => {
  assert.equal(CHAT_SIDEBAR_MIN_WIDTH, 0);
  assert.equal(clampChatSidebarWidth(0, 760), 0);
});

test("la fenetre de chat garde au moins 360 pixels", () => {
  assert.equal(chatSidebarMaxWidth(760), 400);
  assert.equal(clampChatSidebarWidth(420, 760), 400);
});
