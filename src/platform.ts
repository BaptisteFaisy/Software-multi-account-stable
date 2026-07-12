import { invoke as tauriInvoke } from "@tauri-apps/api/core";
import { listen as tauriListen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { TerminalInputBuffer, terminalTransportErrorMessage } from "./terminal-transport";

export type UnlistenFn = () => void;

export type RealtimeConnectionState = "connecting" | "live" | "reconnecting" | "closed" | "unsupported";

export type DiscussionStreamMessage =
  | { type: "dashboard"; dashboard: unknown }
  | { type: "transcript"; accountId: string; sessionId: string; transcript: unknown }
  | { type: "error"; message: string }
  | { type: "pong" };

type Listener<T> = (event: { payload: T }) => void;

type RemoteStartResponse = {
  id: number;
  workspaceId: string;
  workspacePath: string;
};

type RemoteNodeConfig = {
  id: string;
  label: string;
  baseUrl: string;
  token: string;
  priority: number;
};

type RemoteNodeHealth = {
  ok: boolean;
  nodeId: string;
  nodeLabel: string;
  publicBaseUrl: string;
  activeTerminals: number;
  capacity: number;
  startedAt: number;
  // Champs ajoutes par le serveur self-updating. Optionnels : un ancien noeud
  // (avant cette version) ne les renvoie pas -> traite comme non draine / pret.
  version?: string;
  commit?: string;
  ready?: boolean;
  draining?: boolean;
};

type RemoteTerminalRoute = {
  label: string;
  baseUrl: string;
  token: string;
};

type RemoteWsMessage =
  | { type: "data"; id: number; data: string }
  | { type: "exit"; id: number }
  | { type: "error"; id: number; message: string }
  | { type: "status"; id: number; status: string; workspaceId: string; workspacePath: string }
  | { type: "pong"; id: number };

type ClientStartupConfig = {
  remoteMode: boolean;
  baseUrl?: string | null;
  token?: string | null;
};

type MobileBridge = {
  getBaseUrl?: () => string;
  getToken?: () => string;
  setConfig?: (baseUrl: string, token: string) => void;
  openSettings?: () => void;
};

const REMOTE_ENABLED_KEY = "codex-switch-terminal.remote.enabled";
const REMOTE_BASE_URL_KEY = "codex-switch-terminal.remote.base-url";
const REMOTE_TOKEN_KEY = "codex-switch-terminal.remote.token";
const REMOTE_NODES_KEY = "codex-switch-terminal.remote.nodes";

const listeners = new Map<string, Set<Listener<any>>>();
const remoteSockets = new Map<number, WebSocket>();
const remoteTerminalRoutes = new Map<number, RemoteTerminalRoute>();
const remoteStartingTerminals = new Set<number>();
const remotePendingTerminalInput = new TerminalInputBuffer();
const remoteTerminalReconnectTimers = new Map<number, number>();
const remoteTerminalReconnectAttempts = new Map<number, number>();
const remoteStoppingTerminals = new Set<number>();

const REMOTE_TERMINAL_MAX_RECONNECTS = 6;

const viteRemoteBase =
  (typeof import.meta !== "undefined" && import.meta.env?.VITE_CST_API_BASE_URL
    ? String(import.meta.env.VITE_CST_API_BASE_URL)
    : "") || "";
const viteRemoteNodes =
  (typeof import.meta !== "undefined" && import.meta.env?.VITE_CST_REMOTE_NODES
    ? String(import.meta.env.VITE_CST_REMOTE_NODES)
    : "") || "";

export const isTauriRuntime = () =>
  typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

export const isRemoteMode = () =>
  !isTauriRuntime() ||
  localStorage.getItem(REMOTE_ENABLED_KEY) === "1" ||
  viteRemoteBase.trim().length > 0;

export const remoteBaseUrl = () => {
  const saved = localStorage.getItem(REMOTE_BASE_URL_KEY)?.trim();
  if (saved) return saved.replace(/\/+$/, "");
  if (viteRemoteBase.trim()) return viteRemoteBase.trim().replace(/\/+$/, "");
  return window.location.origin.replace(/\/+$/, "");
};

export const remoteToken = () => localStorage.getItem(REMOTE_TOKEN_KEY)?.trim() ?? "";

export const remoteNodesText = () =>
  localStorage.getItem(REMOTE_NODES_KEY)?.trim() || viteRemoteNodes.trim();

export const hasRemoteAuth = () => !isRemoteMode() || remoteToken().length > 0;

const mobileBridge = (): MobileBridge | null => {
  if (typeof window === "undefined") return null;
  const nativeWindow = window as Window & {
    CstAndroid?: MobileBridge;
    CstIOS?: MobileBridge;
  };
  return nativeWindow.CstIOS ?? nativeWindow.CstAndroid ?? null;
};

const readMobileBridgeConfig = () => {
  const bridge = mobileBridge();
  if (!bridge) return null;

  try {
    return {
      baseUrl: bridge.getBaseUrl?.()?.trim() ?? "",
      token: bridge.getToken?.()?.trim() ?? "",
    };
  } catch {
    return null;
  }
};

export const saveRemoteConfig = (baseUrl: string, token: string, nodesText?: string) => {
  const normalizedBaseUrl = baseUrl.trim().replace(/\/+$/, "");
  const normalizedToken = token.trim();
  localStorage.setItem(REMOTE_ENABLED_KEY, "1");
  localStorage.setItem(REMOTE_BASE_URL_KEY, normalizedBaseUrl);
  localStorage.setItem(REMOTE_TOKEN_KEY, normalizedToken);
  if (nodesText !== undefined) {
    const normalizedNodes = nodesText.trim();
    if (normalizedNodes) {
      localStorage.setItem(REMOTE_NODES_KEY, normalizedNodes);
    } else {
      localStorage.removeItem(REMOTE_NODES_KEY);
    }
  }

  try {
    mobileBridge()?.setConfig?.(normalizedBaseUrl, normalizedToken);
  } catch {
    // Les ponts Android/iOS sont optionnels ; localStorage reste la source web.
  }
};

export const initializePlatform = async () => {
  const mobileConfig = readMobileBridgeConfig();
  if (mobileConfig?.baseUrl || mobileConfig?.token) {
    localStorage.setItem(REMOTE_ENABLED_KEY, "1");
    if (mobileConfig.baseUrl) {
      localStorage.setItem(REMOTE_BASE_URL_KEY, mobileConfig.baseUrl.replace(/\/+$/, ""));
    }
    if (mobileConfig.token) {
      localStorage.setItem(REMOTE_TOKEN_KEY, mobileConfig.token);
    }
  }

  if (!isTauriRuntime()) return;

  try {
    const config = await tauriInvoke<ClientStartupConfig>("client_startup_config");
    if (!config.remoteMode) {
      // L'application locale et l'application Cloud partagent le meme profil
      // WebView. Un ancien lancement Cloud ne doit pas forcer les lancements
      // locaux suivants a continuer d'utiliser fetch() vers ce serveur.
      localStorage.removeItem(REMOTE_ENABLED_KEY);
      return;
    }

    localStorage.setItem(REMOTE_ENABLED_KEY, "1");
    if (config.baseUrl?.trim()) {
      localStorage.setItem(REMOTE_BASE_URL_KEY, config.baseUrl.trim().replace(/\/+$/, ""));
    }
    if (config.token?.trim()) {
      localStorage.setItem(REMOTE_TOKEN_KEY, config.token.trim());
    }
  } catch {
    // Older desktop builds do not have the command; keep local behavior.
  }
};

export const clearRemoteConfig = () => {
  localStorage.removeItem(REMOTE_TOKEN_KEY);
  try {
    mobileBridge()?.setConfig?.(remoteBaseUrl(), "");
  } catch {
    // La deconnexion web reste effective meme si le pont natif est indisponible.
  }
};

const tauriWindow = isTauriRuntime() ? getCurrentWindow() : null;

type BrowserFullscreenDocument = Document & {
  webkitFullscreenElement?: Element | null;
  webkitExitFullscreen?: () => Promise<void> | void;
};

type BrowserFullscreenElement = HTMLElement & {
  webkitRequestFullscreen?: () => Promise<void> | void;
};

const browserFullscreenElement = () => {
  if (typeof document === "undefined") return null;
  const fullscreenDocument = document as BrowserFullscreenDocument;
  return document.fullscreenElement ?? fullscreenDocument.webkitFullscreenElement ?? null;
};

const setBrowserFullscreen = async (fullscreen: boolean) => {
  if (typeof document === "undefined") {
    throw new Error("Le plein ecran n'est pas disponible dans cet environnement.");
  }

  const fullscreenDocument = document as BrowserFullscreenDocument;
  if (fullscreen) {
    if (browserFullscreenElement()) return;
    const root = document.documentElement as BrowserFullscreenElement;
    const requestFullscreen = root.requestFullscreen?.bind(root) ??
      root.webkitRequestFullscreen?.bind(root);
    if (!requestFullscreen) {
      throw new Error("Ce navigateur ne prend pas en charge le mode plein ecran.");
    }
    await requestFullscreen();
    return;
  }

  if (!browserFullscreenElement()) return;
  const exitFullscreen = document.exitFullscreen?.bind(document) ??
    fullscreenDocument.webkitExitFullscreen?.bind(fullscreenDocument);
  if (!exitFullscreen) {
    throw new Error("Impossible de quitter le mode plein ecran dans ce navigateur.");
  }
  await exitFullscreen();
};

export const appWindow = {
  isFullscreen: async () =>
    tauriWindow ? tauriWindow.isFullscreen() : browserFullscreenElement() !== null,
  setFullscreen: async (fullscreen: boolean) => {
    if (tauriWindow) {
      await tauriWindow.setFullscreen(fullscreen);
      return;
    }
    await setBrowserFullscreen(fullscreen);
  },
};

export async function listen<T>(event: string, handler: Listener<T>): Promise<UnlistenFn> {
  if (!isRemoteMode()) {
    return tauriListen<T>(event, handler);
  }

  const set = listeners.get(event) ?? new Set<Listener<any>>();
  set.add(handler);
  listeners.set(event, set);
  return () => {
    set.delete(handler);
  };
}

/**
 * Souscrit au flux partage des discussions du serveur. Sans options, le flux
 * suit l'index ; avec accountId/sessionId il suit le transcript correspondant.
 * La reconnexion est automatique (reseau mobile, sortie de veille, WebView mise
 * en arriere-plan). Le runtime Tauri local utilise le repli par polling de
 * main.ts, car il n'a pas de serveur HTTP a joindre.
 */
export function subscribeDiscussionUpdates(
  options: { accountId?: string; sessionId?: string },
  onMessage: (message: DiscussionStreamMessage) => void,
  onState?: (state: RealtimeConnectionState) => void,
): UnlistenFn {
  if (!isRemoteMode()) {
    onState?.("unsupported");
    return () => undefined;
  }

  let stopped = false;
  let socket: WebSocket | null = null;
  let retryTimer: number | null = null;
  let heartbeatTimer: number | null = null;
  let retryCount = 0;
  let lastMessageAt = 0;

  const clearRetry = () => {
    if (retryTimer !== null) {
      clearTimeout(retryTimer);
      retryTimer = null;
    }
  };

  const clearHeartbeat = () => {
    if (heartbeatTimer !== null) {
      clearInterval(heartbeatTimer);
      heartbeatTimer = null;
    }
  };

  const startHeartbeat = (target: WebSocket) => {
    clearHeartbeat();
    heartbeatTimer = window.setInterval(() => {
      if (socket !== target || target.readyState !== WebSocket.OPEN) return;
      if (Date.now() - lastMessageAt > 45_000) {
        target.close();
        return;
      }
      target.send(JSON.stringify({ type: "ping" }));
    }, 15_000);
  };

  const connect = () => {
    if (stopped || socket?.readyState === WebSocket.OPEN || socket?.readyState === WebSocket.CONNECTING) {
      return;
    }
    clearRetry();
    onState?.(retryCount > 0 ? "reconnecting" : "connecting");

    const route = defaultRemoteRoute();
    const wsBase = route.baseUrl.startsWith("https://")
      ? route.baseUrl.replace(/^https:\/\//, "wss://")
      : route.baseUrl.replace(/^http:\/\//, "ws://");
    const query = new URLSearchParams({ token: route.token });
    if (options.accountId && options.sessionId) {
      query.set("accountId", options.accountId);
      query.set("sessionId", options.sessionId);
    }

    const next = new WebSocket(`${wsBase}/ws/discussions?${query.toString()}`);
    socket = next;
    next.addEventListener("open", () => {
      if (socket !== next || stopped) return;
      retryCount = 0;
      lastMessageAt = Date.now();
      startHeartbeat(next);
      onState?.("live");
    });
    next.addEventListener("message", (event) => {
      if (socket !== next || stopped) return;
      lastMessageAt = Date.now();
      try {
        onMessage(JSON.parse(String(event.data)) as DiscussionStreamMessage);
      } catch {
        // Ignore un paquet incomplet/inconnu ; le prochain snapshot est complet.
      }
    });
    next.addEventListener("close", () => {
      if (socket === next) socket = null;
      clearHeartbeat();
      if (stopped) return;
      retryCount += 1;
      onState?.("reconnecting");
      const delay = Math.min(10_000, 500 * 2 ** Math.min(retryCount - 1, 5));
      retryTimer = window.setTimeout(connect, delay);
    });
    next.addEventListener("error", () => {
      // `close` planifie la reconnexion et centralise les changements d'etat.
      next.close();
    });
  };

  const onVisibilityChange = () => {
    if (document.visibilityState !== "visible") return;
    if (!socket) {
      connect();
    } else if (socket.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify({ type: "ping" }));
    }
  };
  document.addEventListener("visibilitychange", onVisibilityChange);
  connect();

  return () => {
    stopped = true;
    clearRetry();
    clearHeartbeat();
    document.removeEventListener("visibilitychange", onVisibilityChange);
    socket?.close();
    socket = null;
    onState?.("closed");
  };
}

export async function invoke<T = unknown>(command: string, args: Record<string, any> = {}): Promise<T> {
  if (!isRemoteMode()) {
    return tauriInvoke<T>(command, args);
  }

  return remoteInvoke<T>(command, args);
}

async function remoteInvoke<T>(command: string, args: Record<string, any>): Promise<T> {
  switch (command) {
    case "load_settings":
      return api<T>("GET", "/api/settings");
    case "save_settings":
      return api<T>("PUT", "/api/settings", args.settings);
    case "ensure_account_home":
      return api<T>("POST", "/api/accounts/home", {
        codexHome: args.codexHome,
        provider: args.provider ?? null,
        bypass: args.bypass ?? true,
        model: args.model ?? null,
        reasoningEffort: args.reasoningEffort ?? null,
      });
    case "export_discussion_transcript":
      return api<T>("POST", "/api/discussions/export", {
        accountId: args.accountId,
        sessionId: args.sessionId,
      });
    case "import_account_json":
      return api<T>("POST", "/api/accounts/import", { content: args.content });
    case "import_account_docs":
      throw new Error("En mode SaaS, colle le contenu JSON plutot qu'un chemin de fichier local.");
    case "remove_account":
      return api<T>(
        "DELETE",
        `/api/accounts/${encodeURIComponent(args.accountId)}?deleteFiles=${
          args.deleteFiles ? "true" : "false"
        }`,
      );
    case "account_limit_status":
      return api<T>("GET", "/api/limits");
    case "usage_dashboard":
      return api<T>("GET", "/api/usage");
    case "account_token_usage":
      return api<T>("GET", "/api/account-usage");
    case "pool_status":
      return api<T>("GET", "/api/pool/status");
    case "pool_start":
      return api<T>("POST", "/api/pool/start");
    case "pool_stop":
      return api<T>("POST", "/api/pool/stop");
    case "pool_pick_terminal_account":
      return pickRemotePoolAccount<T>();
    case "start_terminal":
      return startRemoteTerminal<T>(args);
    case "list_dir":
      return api<T>(
        "GET",
        `/api/fs/list${args.path ? `?path=${encodeURIComponent(String(args.path))}` : ""}`,
      );
    case "write_terminal":
      writeRemoteTerminal(args.id, args.data);
      return undefined as T;
    case "resize_terminal":
      resizeRemoteTerminal(args.id, args.cols, args.rows);
      return undefined as T;
    case "stop_terminal":
      await stopRemoteTerminal(args.id);
      return undefined as T;
    case "pick_project_dir":
      return null as T;
    case "kombai_status":
      return api<T>("GET", "/api/kombai/status");
    case "kombai_start":
      return api<T>("POST", "/api/kombai/start", { projectDir: args.projectDir });
    case "kombai_stop":
      return api<T>("POST", "/api/kombai/stop");
    case "kombai_install_extension":
      return api<T>("POST", "/api/kombai/install-extension");
    case "launch_ide":
      throw new Error("Le lancement d'IDE local n'est pas disponible en mode SaaS.");
    case "list_discussions":
      return api<T>("GET", "/api/discussions");
    case "get_discussion_transcript":
      return api<T>(
        "GET",
        `/api/discussions/transcript?accountId=${encodeURIComponent(String(args.accountId))}&sessionId=${encodeURIComponent(String(args.sessionId))}`,
      );
    case "account_model_catalog":
      return api<T>(
        "GET",
        `/api/chat/models?accountId=${encodeURIComponent(String(args.accountId))}`,
      );
    case "start_chat_turn":
      return api<T>("POST", "/api/chat/turns", {
        accountId: args.accountId,
        sessionId: args.sessionId ?? null,
        prompt: args.prompt,
        projectDir: args.projectDir ?? null,
        mode: args.mode ?? "build",
        model: args.model ?? null,
        reasoningEffort: args.reasoningEffort ?? null,
      });
    case "chat_turn_status":
      return api<T>("GET", `/api/chat/turns/${encodeURIComponent(String(args.id))}`);
    case "stop_chat_turn":
      return api<T>("DELETE", `/api/chat/turns/${encodeURIComponent(String(args.id))}`);
    case "list_prompt_history":
      return {
        generatedAt: Math.floor(Date.now() / 1000),
        totalPrompts: 0,
        returned: 0,
        truncated: false,
        prompts: [],
      } as T;
    case "claim_session_for_terminal":
      return api<T>("POST", "/api/discussions/claim", {
        accountId: args.accountId,
        afterUnix: args.afterUnix,
        excludeSessionIds: args.excludeSessionIds ?? [],
        matchSessionId: args.matchSessionId ?? null,
      });
    case "copy_discussion_to_account":
      return api<T>("POST", "/api/discussions/copy", {
        sessionId: args.sessionId,
        sourceAccountId: args.sourceAccountId,
        targetAccountId: args.targetAccountId,
      });
    case "move_discussion":
      return api<T>("POST", "/api/discussions/move", {
        accountId: args.accountId,
        sessionId: args.sessionId,
        workspacePath: args.workspacePath,
      });
    case "delete_discussion":
      return api<T>("POST", "/api/discussions/delete", {
        accountId: args.accountId,
        sessionId: args.sessionId,
        archive: args.archive,
      });
    case "room_status":
      return api<T>(
        "GET",
        `/api/room/status${args.workspacePath ? `?workspacePath=${encodeURIComponent(args.workspacePath)}` : ""}`,
      );
    case "room_messages":
      {
        const query = new URLSearchParams();
        if (args.since) query.set("since", String(args.since));
        if (args.workspacePath) query.set("workspacePath", String(args.workspacePath));
        return api<T>("GET", `/api/room/messages${query.size ? `?${query}` : ""}`);
      }
    case "room_send":
      return api<T>("POST", "/api/room/send", {
        text: args.text,
        to: args.to ?? null,
        workspacePath: args.workspacePath ?? null,
      });
    default:
      throw new Error(`Commande remote non supportee: ${command}`);
  }
}

async function api<T>(method: string, path: string, body?: unknown): Promise<T> {
  return apiAt<T>(defaultRemoteRoute(), method, path, body);
}

async function apiAt<T>(
  route: RemoteTerminalRoute,
  method: string,
  path: string,
  body?: unknown,
  timeoutMs?: number,
): Promise<T> {
  const controller = timeoutMs ? new AbortController() : null;
  const timeout = controller
    ? window.setTimeout(() => controller.abort(), timeoutMs)
    : null;

  try {
    const response = await fetch(`${route.baseUrl}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${route.token}`,
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: controller?.signal,
    });

    const text = await response.text();
    const value = text ? JSON.parse(text) : null;
    if (!response.ok) {
      const message = value?.error?.message || value?.message || response.statusText;
      if (response.status === 401 && route.baseUrl === remoteBaseUrl()) clearRemoteConfig();
      throw new Error(message);
    }
    return value as T;
  } finally {
    if (timeout !== null) window.clearTimeout(timeout);
  }
}

function defaultRemoteRoute(): RemoteTerminalRoute {
  return {
    label: "Serveur principal",
    baseUrl: remoteBaseUrl(),
    token: remoteToken(),
  };
}

function normalizeBaseUrl(value: string) {
  return value.trim().replace(/\/+$/, "");
}

function parseRemoteNodeLine(line: string, index: number): RemoteNodeConfig | null {
  const parts = line.split("|").map((part) => part.trim());
  if (!parts[0] || parts[0].startsWith("#")) return null;

  const hasLabel = parts[1]?.startsWith("http://") || parts[1]?.startsWith("https://");
  const label = hasLabel ? parts[0] : `Noeud ${index + 1}`;
  const baseUrl = normalizeBaseUrl(hasLabel ? parts[1] : parts[0]);
  if (!baseUrl.startsWith("http://") && !baseUrl.startsWith("https://")) return null;

  const token = (hasLabel ? parts[2] : parts[1]) || remoteToken();
  const priorityRaw = hasLabel ? parts[3] : parts[2];
  const priority = Number.isFinite(Number(priorityRaw)) ? Number(priorityRaw) : 50 + index;

  return {
    id: `${label}-${baseUrl}`.toLowerCase(),
    label,
    baseUrl,
    token,
    priority,
  };
}

function parseRemoteNodes(): RemoteNodeConfig[] {
  const raw = remoteNodesText();
  const parsed = raw
    ? raw
        .split(/\r?\n/)
        .map((line, index) => parseRemoteNodeLine(line, index))
        .filter((node): node is RemoteNodeConfig => node !== null)
    : [];

  const primary: RemoteNodeConfig = {
    id: "primary",
    label: "Serveur principal",
    baseUrl: remoteBaseUrl(),
    token: remoteToken(),
    priority: 100,
  };
  const nodes = [...parsed, primary].filter((node) => node.token.trim().length > 0);
  const seen = new Set<string>();
  return nodes
    .filter((node) => {
      const key = node.baseUrl.toLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .sort((a, b) => a.priority - b.priority);
}

async function terminalNodeCandidates() {
  const nodes = parseRemoteNodes();
  const results = await Promise.all(
    nodes.map(async (node) => {
      const route = nodeToRoute(node);
      try {
        const health = await apiAt<RemoteNodeHealth>(route, "GET", "/api/health", undefined, 1200);
        const capacity = Math.max(1, health.capacity || 1);
        return {
          node,
          route: {
            ...route,
            label: health.nodeLabel || node.label,
          },
          score: (health.activeTerminals || 0) / capacity + node.priority / 100,
          // Un noeud en drain ou non pret (mise a jour en cours) sort du tier
          // "healthy" et retombe en fallback : on ne lui envoie de NOUVEAUX
          // terminaux qu'en dernier recours. Retro-compatible : champs absents
          // sur un ancien noeud -> considere pret et non draine.
          healthy:
            health.ok !== false &&
            health.draining !== true &&
            health.ready !== false,
        };
      } catch {
        return {
          node,
          route,
          score: Number.POSITIVE_INFINITY,
          healthy: false,
        };
      }
    }),
  );

  const healthy = results
    .filter((result) => result.healthy)
    .sort((a, b) => a.score - b.score || a.node.priority - b.node.priority);
  const fallback = results
    .filter((result) => !result.healthy)
    .sort((a, b) => a.node.priority - b.node.priority);
  return [...healthy, ...fallback].map((result) => result.route);
}

function nodeToRoute(node: RemoteNodeConfig): RemoteTerminalRoute {
  return {
    label: node.label,
    baseUrl: node.baseUrl,
    token: node.token,
  };
}

async function pickRemotePoolAccount<T>() {
  const settings: any = await api("GET", "/api/settings");
  const account = settings.accounts?.find((item: any) => item.codexHome) ?? settings.accounts?.[0];
  if (!account) throw new Error("Aucun compte disponible dans le pool SaaS.");
  return account as T;
}

async function startRemoteTerminal<T>(args: Record<string, any>): Promise<T> {
  const requestedId = Number(args.id);
  if (Number.isFinite(requestedId)) remoteStartingTerminals.add(requestedId);

  const payload = {
    id: args.id,
    accountId: args.accountId,
    repoUrl: args.repoUrl,
    workspacePath: args.workspacePath,
    branch: args.branch,
    cols: args.cols,
    rows: args.rows,
    command: args.command,
    agentId: args.agentId,
  };
  let lastError: unknown = null;

  try {
    const candidates = await terminalNodeCandidates();
    for (const route of candidates) {
      try {
        const response = await apiAt<RemoteStartResponse>(route, "POST", "/api/terminals", payload);
        if (Number.isFinite(requestedId) && requestedId !== response.id) {
          movePendingTerminalInput(requestedId, response.id);
        }
        remoteTerminalRoutes.set(response.id, route);
        emit("pty-data", {
          id: response.id,
          data: `\r\n[Route] Terminal sur ${route.label} (${route.baseUrl})\r\n`,
        });
        openTerminalSocket(response.id, route);
        return response as T;
      } catch (error) {
        lastError = error;
      }
    }

    throw lastError ?? new Error("Aucun noeud terminal disponible.");
  } finally {
    if (Number.isFinite(requestedId)) {
      remoteStartingTerminals.delete(requestedId);
      if (!remoteTerminalRoutes.has(requestedId)) remotePendingTerminalInput.clear(requestedId);
    }
  }
}

function openTerminalSocket(id: number, route = remoteTerminalRoutes.get(id) ?? defaultRemoteRoute()) {
  clearRemoteTerminalReconnectTimer(id);
  const previous = remoteSockets.get(id);
  if (previous && previous.readyState !== WebSocket.CLOSED) previous.close();

  const base = route.baseUrl;
  const wsBase = base.startsWith("https://")
    ? base.replace(/^https:\/\//, "wss://")
    : base.replace(/^http:\/\//, "ws://");
  let socket: WebSocket;
  try {
    socket = new WebSocket(`${wsBase}/ws/terminals/${id}?token=${encodeURIComponent(route.token)}`);
  } catch (error) {
    emitTerminalTransportError(id, route, error);
    scheduleRemoteTerminalReconnect(id, route);
    return;
  }
  remoteSockets.set(id, socket);

  socket.addEventListener("open", () => {
    if (remoteSockets.get(id) !== socket) return;
    remoteTerminalReconnectAttempts.delete(id);
    const pending = takePendingTerminalInput(id);
    if (pending) socket.send(JSON.stringify({ type: "input", data: pending }));
  });

  socket.addEventListener("message", (event) => {
    if (remoteSockets.get(id) !== socket) return;
    const message = JSON.parse(String(event.data)) as RemoteWsMessage;
    if (message.type === "data") {
      emit("pty-data", { id: message.id, data: message.data });
    } else if (message.type === "exit") {
      remoteSockets.delete(message.id);
      remoteTerminalRoutes.delete(message.id);
      clearRemoteTerminalReconnectTimer(message.id);
      remoteTerminalReconnectAttempts.delete(message.id);
      remotePendingTerminalInput.clear(message.id);
      emit("pty-exit", { id: message.id });
    } else if (message.type === "error") {
      emit("pty-data", { id: message.id, data: `\r\n${message.message}\r\n` });
    } else if (message.type === "status") {
      // Message de controle uniquement. L'injecter dans xterm deplace le
      // curseur a l'insu de la TUI et son prochain redraw peut alors effacer la
      // ligne en cours. Le chemin du workspace figure deja dans la banniere PTY.
    }
  });

  socket.addEventListener("close", () => {
    if (remoteSockets.get(id) !== socket) return;
    remoteSockets.delete(id);
    if (remoteStoppingTerminals.has(id) || !remoteTerminalRoutes.has(id)) return;
    scheduleRemoteTerminalReconnect(id, route);
  });

  socket.addEventListener("error", () => {
    try {
      socket.close();
    } catch {
      scheduleRemoteTerminalReconnect(id, route);
    }
  });
}

function writeRemoteTerminal(id: number, data: string) {
  const socket = remoteSockets.get(id);
  if (socket?.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify({ type: "input", data }));
    return;
  }

  if (socket?.readyState === WebSocket.CONNECTING || remoteStartingTerminals.has(id)) {
    queuePendingTerminalInput(id, data);
    return;
  }

  const route = remoteTerminalRoutes.get(id) ?? defaultRemoteRoute();
  void apiAt(route, "POST", `/api/terminals/${id}/write`, { data }).catch((error) => {
    const message = terminalTransportErrorMessage(route.baseUrl, error);
    emit("pty-data", { id, data: `\r\n${message}\r\n` });
    if (/session terminal introuvable/i.test(String(error))) {
      remoteTerminalRoutes.delete(id);
      clearRemoteTerminalReconnectTimer(id);
      remoteTerminalReconnectAttempts.delete(id);
      remotePendingTerminalInput.clear(id);
      emit("pty-exit", { id });
    }
  });
}

function resizeRemoteTerminal(id: number, cols: number, rows: number) {
  const socket = remoteSockets.get(id);
  if (socket?.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify({ type: "resize", cols, rows }));
    return;
  }
  if (socket?.readyState === WebSocket.CONNECTING || remoteStartingTerminals.has(id)) return;
  const route = remoteTerminalRoutes.get(id) ?? defaultRemoteRoute();
  void apiAt(route, "POST", `/api/terminals/${id}/resize`, { cols, rows }).catch(() => undefined);
}

async function stopRemoteTerminal(id: number) {
  const route = remoteTerminalRoutes.get(id) ?? defaultRemoteRoute();
  remoteStoppingTerminals.add(id);
  clearRemoteTerminalReconnectTimer(id);
  remoteTerminalReconnectAttempts.delete(id);
  remotePendingTerminalInput.clear(id);
  const socket = remoteSockets.get(id);
  if (socket?.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify({ type: "stop" }));
  }
  socket?.close();
  remoteSockets.delete(id);
  remoteTerminalRoutes.delete(id);
  try {
    await apiAt(route, "DELETE", `/api/terminals/${id}`);
  } catch {
    // La fermeture locale reste effective meme si le noeud est deja parti.
  } finally {
    remoteStoppingTerminals.delete(id);
  }
}

function queuePendingTerminalInput(id: number, data: string) {
  remotePendingTerminalInput.append(id, data);
}

function takePendingTerminalInput(id: number) {
  return remotePendingTerminalInput.take(id);
}

function movePendingTerminalInput(from: number, to: number) {
  remotePendingTerminalInput.move(from, to);
}

function clearRemoteTerminalReconnectTimer(id: number) {
  const timer = remoteTerminalReconnectTimers.get(id);
  if (timer !== undefined) window.clearTimeout(timer);
  remoteTerminalReconnectTimers.delete(id);
}

function scheduleRemoteTerminalReconnect(id: number, route: RemoteTerminalRoute) {
  if (
    remoteStoppingTerminals.has(id) ||
    !remoteTerminalRoutes.has(id) ||
    remoteTerminalReconnectTimers.has(id)
  ) {
    return;
  }

  const attempt = (remoteTerminalReconnectAttempts.get(id) ?? 0) + 1;
  remoteTerminalReconnectAttempts.set(id, attempt);
  if (attempt > REMOTE_TERMINAL_MAX_RECONNECTS) {
    remoteTerminalRoutes.delete(id);
    remotePendingTerminalInput.clear(id);
    emit("pty-data", {
      id,
      data: "\r\nConnexion au terminal perdue. Ouvre un nouveau terminal pour continuer.\r\n",
    });
    emit("pty-exit", { id });
    return;
  }

  const delay = Math.min(5_000, 250 * 2 ** (attempt - 1));
  const timer = window.setTimeout(() => {
    remoteTerminalReconnectTimers.delete(id);
    if (!remoteTerminalRoutes.has(id) || remoteStoppingTerminals.has(id)) return;
    openTerminalSocket(id, remoteTerminalRoutes.get(id) ?? route);
  }, delay);
  remoteTerminalReconnectTimers.set(id, timer);
}

function emitTerminalTransportError(id: number, route: RemoteTerminalRoute, error: unknown) {
  const message = terminalTransportErrorMessage(route.baseUrl, error);
  emit("pty-data", { id, data: `\r\n${message}\r\n` });
}

function emit<T>(event: string, payload: T) {
  listeners.get(event)?.forEach((handler) => handler({ payload }));
}
