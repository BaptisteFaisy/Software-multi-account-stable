#!/usr/bin/env node
/**
 * Non-secret Codex auth diagnostic.
 *
 * Default:
 *   node diagnose-codex-auth.cjs
 *
 * Specific file:
 *   node diagnose-codex-auth.cjs "%USERPROFILE%\.codex-pool-name\auth.json"
 *
 * Live refresh test, using the Codex CLI OAuth client:
 *   node diagnose-codex-auth.cjs "%USERPROFILE%\.codex-pool-name\auth.json" --refresh-like-codex --save
 *
 * The live refresh path requires --save so a successful refresh cannot rotate a
 * refresh token without persisting the replacement.
 */

const fs = require("fs");
const os = require("os");
const path = require("path");

const AUTH_BASE = "https://auth.openai.com";
const CODEX_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
const PLATFORM_CLIENT_ID = "app_2SKx67EdpoN0G6j64rFvigXD";
const CODEX_SCOPE = "openid profile email offline_access api.connectors.read api.connectors.invoke";

const args = process.argv.slice(2);
const wantsHelp = args.includes("--help") || args.includes("-h");
const refreshLikeCodex = args.includes("--refresh-like-codex");
const saveRefresh = args.includes("--save");
const fileArg = args.find((arg) => !arg.startsWith("--"));

const expandEnv = (value) =>
  value
    .replace(/^~(?=\\|\/|$)/, os.homedir())
    .replace(/%([^%]+)%/g, (_, name) => process.env[name] || `%${name}%`);

const defaultAuthFile = () => {
  const poolAuth = path.join(os.homedir(), ".codex-pool-nicholsonstrathy39-hotmail-com", "auth.json");
  if (fs.existsSync(poolAuth)) return poolAuth;
  return path.join(os.homedir(), ".codex", "auth.json");
};

const usage = () => {
  console.log(`Usage:
  node diagnose-codex-auth.cjs [auth-or-cpa-json]
  node diagnose-codex-auth.cjs [auth-or-cpa-json] --refresh-like-codex --save

What it prints:
  - token presence, expiry, scopes, account id, email
  - OAuth client label: codex, platform, other, unknown
  - whether Codex CLI can refresh this file

No access_token or refresh_token is printed.`);
};

const parseJsonPossiblyPasted = (content) => {
  let current = content.trim();
  for (let i = 0; i < 4; i += 1) {
    const parsed = JSON.parse(current);
    if (typeof parsed === "string") {
      current = parsed.trim();
      continue;
    }
    return parsed;
  }
  throw new Error("JSON content stayed a string after repeated decoding");
};

const b64urlToJson = (part) => {
  const padded = part.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(part.length / 4) * 4, "=");
  return JSON.parse(Buffer.from(padded, "base64").toString("utf8"));
};

const decodeJwt = (token) => {
  if (!token || typeof token !== "string") return {};
  const parts = token.split(".");
  if (parts.length < 2) return {};
  try {
    return b64urlToJson(parts[1]);
  } catch {
    return {};
  }
};

const asArray = (value) => {
  if (Array.isArray(value)) return value;
  if (typeof value === "string" && value) return [value];
  return [];
};

const unixToIso = (seconds) => {
  if (!Number.isFinite(Number(seconds))) return "";
  return new Date(Number(seconds) * 1000).toISOString();
};

const clientLabel = (clientId) => {
  if (clientId === CODEX_CLIENT_ID) return "codex";
  if (clientId === PLATFORM_CLIENT_ID) return "platform";
  if (clientId) return "other";
  return "unknown";
};

const readAuth = (file) => {
  const raw = fs.readFileSync(file, "utf8");
  const value = parseJsonPossiblyPasted(raw);
  const tokens = value.tokens && typeof value.tokens === "object" ? value.tokens : value;
  return {
    value,
    format: value.tokens ? "codex-home auth.json" : "flat import json",
    accessToken: tokens.access_token || "",
    refreshToken: tokens.refresh_token || "",
    idToken: tokens.id_token || "",
    accountId: tokens.account_id || value.account_id || value.chatgpt_account_id || "",
    explicitClientId: tokens.client_id || value.client_id || "",
  };
};

const deriveFacts = (auth) => {
  const access = decodeJwt(auth.accessToken);
  const id = decodeJwt(auth.idToken);
  const profile = access["https://api.openai.com/profile"] || {};
  const authInfo = access["https://api.openai.com/auth"] || {};
  const idAuthInfo = id["https://api.openai.com/auth"] || {};
  const clientId =
    auth.explicitClientId ||
    access.client_id ||
    asArray(id.aud).find((aud) => String(aud).startsWith("app_")) ||
    "";

  return {
    access,
    id,
    clientId,
    clientLabel: clientLabel(clientId),
    issuer: access.iss || "",
    audience: asArray(access.aud).join(" "),
    scopes: asArray(access.scp).join(" ") || access.scope || "",
    email: profile.email || id.email || "",
    accountId:
      auth.accountId ||
      authInfo.chatgpt_account_id ||
      idAuthInfo.chatgpt_account_id ||
      authInfo.user_id ||
      idAuthInfo.user_id ||
      "",
    plan: authInfo.chatgpt_plan_type || idAuthInfo.chatgpt_plan_type || "",
    expIso: unixToIso(access.exp),
    expired: access.exp ? Number(access.exp) <= Math.floor(Date.now() / 1000) : false,
  };
};

const printFacts = (file, auth, facts) => {
  const compatible = Boolean(auth.accessToken && auth.refreshToken && facts.clientLabel === "codex");
  console.log("");
  console.log("=== Codex auth diagnostic ===");
  console.log(`File:                 ${file}`);
  console.log(`Format:               ${auth.format}`);
  console.log(`Email:                ${facts.email || "(unknown)"}`);
  console.log(`Account id:           ${facts.accountId || "(unknown)"}`);
  console.log(`Plan:                 ${facts.plan || "(unknown)"}`);
  console.log(`Access token:         ${auth.accessToken ? "present" : "missing"}`);
  console.log(`Refresh token:        ${auth.refreshToken ? "present" : "missing"}`);
  console.log(`Access expires:       ${facts.expIso || "(unknown)"}${facts.expired ? " EXPIRED" : ""}`);
  console.log(`OAuth client:         ${facts.clientId || "(unknown)"} (${facts.clientLabel})`);
  console.log(`Audience:             ${facts.audience || "(unknown)"}`);
  console.log(`Scopes:               ${facts.scopes || "(unknown)"}`);
  console.log(`Codex CLI compatible: ${compatible ? "yes" : "no"}`);

  if (!compatible) {
    console.log("");
    console.log("Reason:");
    if (!auth.accessToken) console.log("- no access token");
    if (!auth.refreshToken) console.log("- no refresh token");
    if (facts.clientLabel === "platform") {
      console.log(`- this refresh token was issued for the Platform/Web client (${PLATFORM_CLIENT_ID})`);
      console.log(`- Codex CLI refreshes with the Codex client (${CODEX_CLIENT_ID})`);
      console.log("- that mismatch produces HTTP 401 invalid_client / Invalid client specified");
    } else if (facts.clientLabel !== "codex") {
      console.log("- OAuth client is not the Codex CLI client");
    }
  }
  console.log("");
};

const compactValue = (value) => {
  if (!value) return "";
  if (typeof value === "string") return value;
  if (typeof value === "object") {
    return value.code || value.message || JSON.stringify(value);
  }
  return String(value);
};

const refreshWithCodexClient = async (file, auth, facts) => {
  if (!auth.refreshToken) {
    throw new Error("No refresh token to test");
  }
  if (!saveRefresh) {
    throw new Error("Refusing live refresh without --save, because refresh tokens may rotate");
  }

  const body = new URLSearchParams({
    grant_type: "refresh_token",
    client_id: CODEX_CLIENT_ID,
    refresh_token: auth.refreshToken,
    scope: CODEX_SCOPE,
  });

  const resp = await fetch(`${AUTH_BASE}/oauth/token`, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      accept: "application/json",
      "user-agent": "codex-auth-diagnostic/1.0",
    },
    body: body.toString(),
  });

  const data = await resp.json().catch(() => ({}));
  if (!resp.ok || !data.access_token) {
    const errorText = compactValue(data.error);
    const messageText = compactValue(data.error_description) || compactValue(data.message) || compactValue(data.error);
    console.log("Codex refresh test:  FAILED");
    console.log(`HTTP status:          ${resp.status}`);
    console.log(`OAuth error:          ${errorText || "(none)"}`);
    console.log(`Message:              ${messageText || "(none)"}`);
    if (facts.clientLabel === "platform") {
      console.log("");
      console.log("This is the same class of failure as Codex CLI: the token belongs to the Platform/Web client.");
    }
    process.exitCode = 1;
    return;
  }

  const backup = `${file}.bak-${new Date().toISOString().replace(/[:.]/g, "")}`;
  fs.copyFileSync(file, backup);

  const nextRefreshToken = data.refresh_token || auth.refreshToken;
  if (auth.value.tokens && typeof auth.value.tokens === "object") {
    auth.value.tokens.access_token = data.access_token;
    auth.value.tokens.refresh_token = nextRefreshToken;
    if (data.id_token) auth.value.tokens.id_token = data.id_token;
    auth.value.last_refresh = new Date().toISOString();
  } else {
    auth.value.access_token = data.access_token;
    auth.value.refresh_token = nextRefreshToken;
    if (data.id_token) auth.value.id_token = data.id_token;
    auth.value.client_id = CODEX_CLIENT_ID;
    auth.value.last_refresh = new Date().toISOString();
    const nextClaims = decodeJwt(data.access_token);
    if (nextClaims.exp) auth.value.expired = unixToIso(nextClaims.exp);
  }

  fs.writeFileSync(file, JSON.stringify(auth.value, null, 2));

  console.log("Codex refresh test:  OK");
  console.log(`Updated file:         ${file}`);
  console.log(`Backup:               ${backup}`);
};

const main = async () => {
  if (wantsHelp) {
    usage();
    return;
  }

  const file = path.resolve(expandEnv(fileArg || defaultAuthFile()));
  const auth = readAuth(file);
  const facts = deriveFacts(auth);
  printFacts(file, auth, facts);

  if (refreshLikeCodex) {
    await refreshWithCodexClient(file, auth, facts);
  } else if (facts.clientLabel !== "codex") {
    console.log("Next step:");
    console.log("  Regenerate the JSON with grab-codex-oauth.cjs, then import the new file.");
    console.log("  The new diagnostic must show: OAuth client (...codex) and Codex CLI compatible: yes.");
  }
};

main().catch((error) => {
  console.error(`Error: ${error.message}`);
  process.exit(1);
});
