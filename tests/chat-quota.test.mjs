import assert from "node:assert/strict";
import test from "node:test";

import {
  bestQuotaAccount,
  isQuotaExhaustionError,
  remainingQuotaPercent,
} from "../src/chat/quota.ts";
import { readFileSync } from "node:fs";

const main = readFileSync(new URL("../src/main.ts", import.meta.url), "utf8");

test("reconnait les erreurs de quota sans confondre la fenetre de contexte", () => {
  assert.equal(isQuotaExhaustionError("You've hit your usage limit. Try again later."), true);
  assert.equal(isQuotaExhaustionError("rate_limit_exceeded (HTTP 429)"), true);
  assert.equal(isQuotaExhaustionError("Quota de jetons epuise"), true);
  assert.equal(isQuotaExhaustionError("Maximum context length exceeded"), false);
  assert.equal(isQuotaExhaustionError("Le prompt est trop long"), false);
});

test("le quota restant correspond a la limite la plus contraignante", () => {
  assert.equal(
    remainingQuotaPercent({
      id: "a",
      hasTokens: true,
      sessionUsedPercent: 35,
      weeklyUsedPercent: 72,
      buckets: [],
    }),
    28,
  );
  assert.equal(
    remainingQuotaPercent({
      id: "a",
      hasTokens: true,
      sessionUsedPercent: 1,
      buckets: [{ usedPercent: 2, rateLimitReachedType: "primary" }],
    }),
    0,
  );
});

test("choisit le compte compatible ayant le plus de quota", () => {
  const accounts = [
    { id: "courant", hasTokens: true, sessionUsedPercent: 100 },
    { id: "faible", hasTokens: true, sessionUsedPercent: 75, weeklyUsedPercent: 40 },
    { id: "meilleur", hasTokens: true, sessionUsedPercent: 25, weeklyUsedPercent: 35 },
    { id: "autre-provider", hasTokens: true, sessionUsedPercent: 0, weeklyUsedPercent: 0 },
  ];

  assert.deepEqual(
    bestQuotaAccount(accounts, "courant", ["faible", "meilleur"]),
    { account: accounts[2], remainingPercent: 65 },
  );
});

test("les limites visibles sont reactivees toutes les 30 secondes", () => {
  assert.match(main, /const LIMIT_POLL_INTERVAL_MS = 30_000/);
  assert.match(main, /refreshLimitStatus\(\), LIMIT_POLL_INTERVAL_MS/);
});
