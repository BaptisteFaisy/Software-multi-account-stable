import assert from "node:assert/strict";
import test from "node:test";

import {
  DEFAULT_EXPERT_CHAT_PAGE_SIZE,
  clampExpertChatPage,
  expertChatPageCount,
  expertChatPageForIndex,
  expertChatColumnCount,
  expertChatRowCount,
  expertChatsOnPage,
  normalizeExpertChatPageSize,
} from "../src/chat/expert.ts";

test("la grille propose 6, 9, 12 ou 16 chats par page", () => {
  assert.equal(DEFAULT_EXPERT_CHAT_PAGE_SIZE, 6);
  assert.equal(normalizeExpertChatPageSize("6"), 6);
  assert.equal(normalizeExpertChatPageSize("9"), 9);
  assert.equal(normalizeExpertChatPageSize("12"), 12);
  assert.equal(normalizeExpertChatPageSize("16"), 16);
  assert.equal(normalizeExpertChatPageSize("15"), 6);
  assert.equal(expertChatColumnCount(12), 3);
  assert.equal(expertChatColumnCount(16), 4);
  assert.equal(expertChatRowCount(6), 2);
  assert.equal(expertChatRowCount(9), 3);
  assert.equal(expertChatRowCount(12), 4);
  assert.equal(expertChatRowCount(16), 4);
});

test("les chats sont pagines sans limite et gardent leur ordre", () => {
  const chats = Array.from({ length: 100 }, (_, index) => index + 1);

  assert.equal(expertChatPageCount(chats.length, 6), 17);
  assert.deepEqual(expertChatsOnPage(chats, 0, 6), [1, 2, 3, 4, 5, 6]);
  assert.deepEqual(expertChatsOnPage(chats, 1, 6), [7, 8, 9, 10, 11, 12]);
  assert.deepEqual(expertChatsOnPage(chats, 16, 6), [97, 98, 99, 100]);

  assert.equal(expertChatPageCount(chats.length, 9), 12);
  assert.deepEqual(expertChatsOnPage(chats, 11, 9), [100]);
  assert.equal(expertChatPageCount(chats.length, 12), 9);
  assert.equal(expertChatPageCount(chats.length, 16), 7);
});

test("un nouveau chat est place sur la page suivante", () => {
  assert.equal(expertChatPageForIndex(5, 6), 0);
  assert.equal(expertChatPageForIndex(6, 6), 1);
  assert.equal(expertChatPageForIndex(8, 9), 0);
  assert.equal(expertChatPageForIndex(9, 9), 1);
  assert.equal(expertChatPageForIndex(11, 12), 0);
  assert.equal(expertChatPageForIndex(12, 12), 1);
  assert.equal(expertChatPageForIndex(15, 16), 0);
  assert.equal(expertChatPageForIndex(16, 16), 1);
});

test("la page courante reste toujours valide", () => {
  assert.equal(clampExpertChatPage(-4, 12, 6), 0);
  assert.equal(clampExpertChatPage(8, 12, 6), 1);
  assert.equal(clampExpertChatPage(3, 0, 9), 0);
});
