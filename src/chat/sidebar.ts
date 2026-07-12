export const CHAT_SIDEBAR_DEFAULT_WIDTH = 272;
export const CHAT_SIDEBAR_COMPACT_WIDTH = 244;
export const CHAT_SIDEBAR_MIN_WIDTH = 0;
export const CHAT_SIDEBAR_MAX_WIDTH = 420;

const CHAT_CONTENT_MIN_WIDTH = 360;
const CHAT_COMPACT_VIEWPORT_WIDTH = 980;

export const chatSidebarMaxWidth = (viewportWidth: number): number => {
  const availableWidth = Number.isFinite(viewportWidth)
    ? Math.floor(viewportWidth) - CHAT_CONTENT_MIN_WIDTH
    : CHAT_SIDEBAR_MAX_WIDTH;
  return Math.max(
    CHAT_SIDEBAR_MIN_WIDTH,
    Math.min(CHAT_SIDEBAR_MAX_WIDTH, availableWidth),
  );
};

export const clampChatSidebarWidth = (width: number, viewportWidth: number): number => {
  const safeWidth = Number.isFinite(width) ? Math.round(width) : CHAT_SIDEBAR_DEFAULT_WIDTH;
  return Math.max(
    CHAT_SIDEBAR_MIN_WIDTH,
    Math.min(chatSidebarMaxWidth(viewportWidth), safeWidth),
  );
};

export const defaultChatSidebarWidth = (viewportWidth: number): number =>
  viewportWidth <= CHAT_COMPACT_VIEWPORT_WIDTH
    ? CHAT_SIDEBAR_COMPACT_WIDTH
    : CHAT_SIDEBAR_DEFAULT_WIDTH;
