#!/usr/bin/env node
/**
 * Grab Codex tokens via the same OAuth client/redirect used by Codex CLI.
 *
 * Automatic flow:  node grab-codex-oauth.cjs
 *   - generates PKCE, starts a localhost:1455 callback server, opens browser.
 *   - user logs in, browser returns to localhost, script writes a CPA .json.
 *
 * Manual fallback:  node grab-codex-oauth.cjs "http://localhost:1455/auth/callback?code=...&state=..."
 *   - exchanges the code for tokens, writes a CPA .json to Downloads/.
 *
 * Client: app_EMoamEEZ73f0CkXaXp7hrann (Codex CLI).
 */

const crypto = require("crypto");
const fs = require("fs");
const http = require("http");
const os = require("os");
const path = require("path");
const { exec } = require("child_process");

const AUTH_BASE = "https://auth.openai.com";
const CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
const REDIRECT_URI = "http://localhost:1455/auth/callback";
const AUDIENCE = "https://api.openai.com/v1";
const AUTH0_CLIENT = "eyJuYW1lIjoiYXV0aDAtc3BhLWpzIiwidmVyc2lvbiI6IjEuMjEuMCJ9";
const SCOPE = "openid profile email offline_access api.connectors.read api.connectors.invoke";
const STATE_FILE = path.join(os.tmpdir(), "codex-oauth-state.json");
const CALLBACK_PORT = 1455;
const CALLBACK_TIMEOUT_MS = 10 * 60 * 1000;

const base64url = (buf) =>
  buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

const generatePkce = () => {
  const verifier = base64url(crypto.randomBytes(32));
  const challenge = base64url(crypto.createHash("sha256").update(verifier).digest());
  return { verifier, challenge };
};

const decodeJwt = (token) => {
  try {
    return JSON.parse(Buffer.from(token.split(".")[1], "base64").toString());
  } catch {
    return {};
  }
};

const openBrowser = (url) => {
  const cmd = process.platform === "win32" ? `start "" "${url}"`
    : process.platform === "darwin" ? `open "${url}"`
    : `xdg-open "${url}"`;
  exec(cmd);
};

const browserPage = (title, body) => `<!doctype html>
<html lang="fr">
<head>
  <meta charset="utf-8">
  <title>${title}</title>
  <style>
    body { font-family: system-ui, sans-serif; margin: 48px; line-height: 1.45; max-width: 720px; }
    code { background: #f2f2f2; padding: 2px 5px; border-radius: 4px; }
  </style>
</head>
<body>
  <h1>${title}</h1>
  ${body}
</body>
</html>`;

const sendBrowserPage = (res, status, title, body) => {
  res.writeHead(status, { "content-type": "text/html; charset=utf-8" });
  res.end(browserPage(title, body));
};

const waitForLocalCallback = (authorizeUrl) =>
  new Promise((resolve, reject) => {
    let settled = false;
    let timer = null;

    const settle = (fn, value) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      server.close(() => fn(value));
    };

    const server = http.createServer(async (req, res) => {
      const url = new URL(req.url || "/", REDIRECT_URI);
      if (url.pathname !== "/auth/callback") {
        sendBrowserPage(res, 404, "Callback inconnu", "<p>Cette page ne fait pas partie du flux Codex OAuth.</p>");
        return;
      }

      try {
        const outFile = await finish(`${REDIRECT_URI}${url.search}`);
        sendBrowserPage(
          res,
          200,
          "Token Codex recupere",
          `<p>Le fichier JSON a ete cree dans <code>${outFile}</code>.</p><p>Tu peux fermer cet onglet et importer le fichier dans l'app.</p>`,
        );
        settle(resolve, outFile);
      } catch (error) {
        const message = error && error.message ? error.message : String(error);
        sendBrowserPage(
          res,
          500,
          "Echec OAuth Codex",
          `<p>${message.replace(/[<>&"]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;" }[c]))}</p><p>Relance <code>node grab-codex-oauth.cjs</code>.</p>`,
        );
        settle(reject, error);
      }
    });

    server.on("error", (error) => {
      if (timer) clearTimeout(timer);
      reject(error);
    });

    server.listen(CALLBACK_PORT, () => {
      timer = setTimeout(() => {
        settle(reject, new Error("Timeout: aucun callback recu sur localhost:1455 apres 10 minutes."));
      }, CALLBACK_TIMEOUT_MS);

      console.log(`Serveur local pret: http://localhost:${CALLBACK_PORT}/auth/callback`);
      console.log("Ouverture du navigateur...\n");
      openBrowser(authorizeUrl);
    });
  });

// ── Phase 1: start ───────────────────────────────────────────────────────────
const start = async () => {
  const { verifier, challenge } = generatePkce();
  const state = `${crypto.randomUUID().replace(/-/g, "")}.${base64url(crypto.randomBytes(16))}`;

  const params = new URLSearchParams({
    client_id: CLIENT_ID,
    response_type: "code",
    redirect_uri: REDIRECT_URI,
    audience: AUDIENCE,
    scope: SCOPE,
    state,
    code_challenge: challenge,
    code_challenge_method: "S256",
    prompt: "login",
    id_token_add_organizations: "true",
  });

  const authorizeUrl = `${AUTH_BASE}/oauth/authorize?${params}`;

  fs.writeFileSync(STATE_FILE, JSON.stringify({ verifier, state, createdAt: Date.now() }));

  console.log("\n=== Phase 1: autorisation ===\n");
  console.log("Le navigateur va s'ouvrir. Connecte-toi au compte chatgpt.com.");
  console.log("Le callback localhost sera recupere automatiquement.");
  console.log("URL (si le navigateur ne s'ouvre pas, copie-la manuellement):\n");
  console.log(authorizeUrl);
  console.log("");

  try {
    await waitForLocalCallback(authorizeUrl);
  } catch (error) {
    if (error && error.code === "EADDRINUSE") {
      console.log("Le port localhost:1455 est deja utilise; passage en mode manuel.");
      console.log("Apres connexion, copie TOUTE l'URL de la barre d'adresse, puis lance:");
      console.log('  node grab-codex-oauth.cjs "<URL_COPIEE>"\n');
      openBrowser(authorizeUrl);
      return;
    }
    throw error;
  }
};

// ── Phase 2: finish ──────────────────────────────────────────────────────────
const finish = async (callbackInput) => {
  if (!fs.existsSync(STATE_FILE)) {
    throw new Error("Aucune session PKCE trouvee. Lance d'abord: node grab-codex-oauth.cjs");
  }

  const session = JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
  if (Date.now() - session.createdAt > 10 * 60 * 1000) {
    throw new Error("Session PKCE expiree (>10 min). Relance: node grab-codex-oauth.cjs");
  }

  let code, returnedState;
  const raw = callbackInput.trim();
  if (raw.startsWith("http")) {
    const url = new URL(raw);
    code = url.searchParams.get("code");
    returnedState = url.searchParams.get("state");
    const err = url.searchParams.get("error");
    if (err) {
      throw new Error(`Erreur OAuth: ${err} - ${url.searchParams.get("error_description") || ""}`);
    }
  } else {
    code = raw;
  }

  if (!code) {
    throw new Error("Pas de code dans l'URL fournie.");
  }

  if (returnedState && returnedState !== session.state) {
    throw new Error("Le state ne correspond pas. Relance la phase 1.");
  }

  console.log("\n→ Échange du code contre les tokens...");

  const tokenBody = new URLSearchParams({
    grant_type: "authorization_code",
    client_id: CLIENT_ID,
    code,
    redirect_uri: REDIRECT_URI,
    code_verifier: session.verifier,
  }).toString();

  const resp = await fetch(`${AUTH_BASE}/oauth/token`, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      "accept": "application/json",
      "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36",
    },
    body: tokenBody,
  });

  const data = await resp.json();

  if (!data.access_token) {
    const detail = typeof data.error === "object" ? JSON.stringify(data.error) : (data.error || "");
    throw new Error(`Echec echange (HTTP ${resp.status}): ${detail} ${data.error_description || data.message || ""}`);
  }

  const at = data.access_token;
  const rt = data.refresh_token || "";
  const it = data.id_token || "";
  const ap = decodeJwt(at);
  const ip = decodeJwt(it);
  const now = new Date();
  const exp = ap.exp ? new Date(ap.exp * 1000) : null;
  const profile = ap["https://api.openai.com/profile"] || {};
  const authInfo = ap["https://api.openai.com/auth"] || {};
  const email = profile.email || ip.email || "";
  const name = ip.name || "";
  const idAuthInfo = ip["https://api.openai.com/auth"] || {};
  const accountId = authInfo.chatgpt_account_id || idAuthInfo.chatgpt_account_id || authInfo.user_id || authInfo.chatgpt_user_id || ip.sub || "";
  const userId = authInfo.chatgpt_user_id || idAuthInfo.chatgpt_user_id || authInfo.user_id || idAuthInfo.user_id || accountId;
  const plan = authInfo.chatgpt_plan_type || idAuthInfo.chatgpt_plan_type || "";

  const cpa = {
    type: "codex",
    account_id: accountId,
    chatgpt_account_id: accountId,
    workspace_id: accountId,
    chatgpt_user_id: userId,
    client_id: CLIENT_ID,
    email,
    name,
    plan_type: plan,
    chatgpt_plan_type: plan,
    id_token: it,
    access_token: at,
    refresh_token: rt,
    session_token: "",
    last_refresh: now.toISOString(),
    expired: exp ? exp.toISOString() : "",
  };

  const stamp = now.toISOString().replace(/[:.]/g, "").slice(0, 15);
  const safe = (email || accountId || "account").replace(/[^a-z0-9]/gi, "-").toLowerCase().slice(0, 40);
  const outFile = path.join(os.homedir(), "Downloads", `codex-oauth-${safe}-${stamp}.json`);
  fs.writeFileSync(outFile, JSON.stringify(cpa, null, 2));

  fs.unlinkSync(STATE_FILE);

  console.log("\n========================================");
  console.log("✓ SUCCÈS — tokens récupérés !");
  console.log(`  Email:     ${email}`);
  console.log(`  Name:      ${name}`);
  console.log(`  Plan:      ${plan}`);
  console.log(`  Expire:    ${exp ? exp.toISOString() : "?"}`);
  console.log(`  Access:    ${at.length} chars`);
  console.log(`  Refresh:   ${rt ? rt.length + " chars ✓" : "ABSENT ✗"}`);
  console.log(`  ID token:  ${it.length} chars`);
  console.log(`  Fichier:   ${outFile}`);
  console.log("========================================");
  console.log("\nTu peux importer ce fichier dans ton app (onglet Pool → coller le JSON).");
  return outFile;
};

// ── Entry ────────────────────────────────────────────────────────────────────
const arg = process.argv[2];
const main = async () => {
  if (!arg || arg === "start") {
    await start();
  } else {
    await finish(arg);
  }
};

main().catch((error) => {
  console.error(`Erreur: ${error && error.message ? error.message : String(error)}`);
  process.exit(1);
});
