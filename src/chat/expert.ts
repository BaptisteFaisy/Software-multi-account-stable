export type ExpertGridLayout = "auto" | "2" | "3" | "4";

export const EXPERT_CHAT_PAGE_SIZES = [6, 9, 12, 16] as const;
export type ExpertChatPageSize = (typeof EXPERT_CHAT_PAGE_SIZES)[number];

export const DEFAULT_EXPERT_CHAT_PAGE_SIZE: ExpertChatPageSize = 6;
export const normalizeExpertChatPageSize = (value: unknown): ExpertChatPageSize =>
  EXPERT_CHAT_PAGE_SIZES.find((pageSize) => pageSize === Number(value))
  ?? DEFAULT_EXPERT_CHAT_PAGE_SIZE;

export const expertChatColumnCount = (pageSize: ExpertChatPageSize): number =>
  pageSize === 16 ? 4 : 3;

const normalizeCount = (value: number): number =>
  Number.isFinite(value) ? Math.max(0, Math.trunc(value)) : 0;

export const expertChatPageCount = (
  openChatCount: number,
  pageSize: ExpertChatPageSize,
): number => Math.max(1, Math.ceil(normalizeCount(openChatCount) / pageSize));

export const clampExpertChatPage = (
  page: number,
  openChatCount: number,
  pageSize: ExpertChatPageSize,
): number => {
  const lastPage = expertChatPageCount(openChatCount, pageSize) - 1;
  const normalizedPage = Number.isFinite(page) ? Math.max(0, Math.trunc(page)) : 0;
  return Math.min(normalizedPage, lastPage);
};

export const expertChatPageForIndex = (
  index: number,
  pageSize: ExpertChatPageSize,
): number => Math.floor(normalizeCount(index) / pageSize);

export const expertChatsOnPage = <T>(
  chats: readonly T[],
  page: number,
  pageSize: ExpertChatPageSize,
): T[] => {
  const normalizedPage = clampExpertChatPage(page, chats.length, pageSize);
  const start = normalizedPage * pageSize;
  return chats.slice(start, start + pageSize);
};

export const expertChatRowCount = (pageSize: ExpertChatPageSize): number =>
  pageSize / expertChatColumnCount(pageSize);
