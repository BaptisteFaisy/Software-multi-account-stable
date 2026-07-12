export type ChatQuotaBucket = {
  usedPercent?: number | null;
  rateLimitReachedType?: string | null;
};

export type ChatAccountQuota = {
  id: string;
  hasTokens: boolean;
  sessionUsedPercent?: number | null;
  weeklyUsedPercent?: number | null;
  buckets?: ChatQuotaBucket[];
};

export type BestQuotaAccount<T extends ChatAccountQuota> = {
  account: T;
  remainingPercent: number;
};

const normalizedError = (value: string): string =>
  value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();

/**
 * Distingue un quota de compte epuise d'une limite de contexte ou d'un prompt
 * trop long : seules les premieres doivent proposer de changer de compte.
 */
export const isQuotaExhaustionError = (error: string | null | undefined): boolean => {
  if (!error?.trim()) return false;
  const value = normalizedError(error);
  if (
    /context (?:window|length)|maximum context|prompt (?:is )?too long|message (?:is )?too (?:large|long)/.test(
      value,
    )
  ) {
    return false;
  }

  return [
    /(?:rate|usage)[ _-]?limit(?:ed| has been)? (?:exceeded|reached)/,
    /(?:rate|usage)[ _-]?limit/,
    /you(?:'ve| have) hit your (?:usage|rate) limit/,
    /too many requests/,
    /insufficient[ _-]?quota/,
    /\bquota\b.{0,50}(?:exceeded|exhausted|epuise|atteint|reached)/,
    /(?:exceeded|exhausted|epuise|atteint|reached).{0,50}\bquota\b/,
    /(?:no|zero|0) (?:weighted )?tokens? (?:left|remaining)/,
    /out of (?:weighted )?tokens?/,
    /plus de (?:jetons?|tokens?)/,
    /(?:jetons?|tokens?).{0,30}(?:epuise|indisponible)/,
    /(?:http(?: status)?\s*)?429\b/,
  ].some((pattern) => pattern.test(value));
};

const validPercent = (value: number | null | undefined): value is number =>
  typeof value === "number" && Number.isFinite(value);

/**
 * Le quota utilisable d'un compte est son goulot d'etranglement : si le quota
 * 5 h est libre a 80 % mais l'hebdomadaire a 20 %, il reste effectivement 20 %.
 */
export const remainingQuotaPercent = (account: ChatAccountQuota): number | null => {
  if (!account.hasTokens) return null;
  if (account.buckets?.some((bucket) => bucket.rateLimitReachedType?.trim())) return 0;

  const used = [
    account.sessionUsedPercent,
    account.weeklyUsedPercent,
    ...(account.buckets ?? []).map((bucket) => bucket.usedPercent),
  ].filter(validPercent);
  if (!used.length) return null;
  return Math.max(0, Math.min(100, 100 - Math.max(...used)));
};

/** Choisit le compte compatible qui possede le plus de quota reel restant. */
export const bestQuotaAccount = <T extends ChatAccountQuota>(
  accounts: T[],
  currentAccountId: string,
  eligibleAccountIds: Iterable<string>,
): BestQuotaAccount<T> | null => {
  const eligible = new Set(eligibleAccountIds);
  let best: BestQuotaAccount<T> | null = null;

  for (const account of accounts) {
    if (account.id === currentAccountId || !eligible.has(account.id)) continue;
    const remainingPercent = remainingQuotaPercent(account);
    if (remainingPercent === null || remainingPercent <= 0) continue;
    if (!best || remainingPercent > best.remainingPercent) {
      best = { account, remainingPercent };
    }
  }

  return best;
};
