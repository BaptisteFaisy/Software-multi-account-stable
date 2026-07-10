import { invoke as tauriInvoke } from "@tauri-apps/api/core";
import { listen as tauriListen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";

export type UnlistenFn = () => void;

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

type AndroidBridge = {
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

const androidBridge = (): AndroidBridge | null => {
  if (typeof window === "undefined") return null;
  return ((window as Window & { CstAndroid?: AndroidBridge }).CstAndroid ?? null);
};

const readAndroidBridgeConfig = () => {
  const bridge = androidBridge();
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
    androidBridge()?.setConfig?.(normalizedBaseUrl, normalizedToken);
  } catch {
    // The Android bridge is optional; localStorage remains the source of truth for web.
  }
};

export const initializePlatform = async () => {
  const androidConfig = readAndroidBridgeConfig();
  if (androidConfig?.baseUrl || androidConfig?.token) {
    localStorage.setItem(REMOTE_ENABLED_KEY, "1");
    if (androidConfig.baseUrl) {
      localStorage.setItem(REMOTE_BASE_URL_KEY, androidConfig.baseUrl.replace(/\/+$/, ""));
    }
    if (androidConfig.token) {
      localStorage.setItem(REMOTE_TOKEN_KEY, androidConfig.token);
    }
  }

  if (!isTauriRuntime()) return;

  try {
    const config = await tauriInvoke<ClientStartupConfig>("client_startup_config");
    if (!config.remoteMode) return;

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
};

const tauriWindow = isTauriRuntime() ? getCurrentWindow() : null;

export const appWindow = {
  isFullscreen: async () => (tauriWindow ? tauriWindow.isFullscreen() : false),
  setFullscreen: async (fullscreen: boolean) => {
    if (tauriWindow) await tauriWindow.setFullscreen(fullscreen);
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
      return api<T>("POST", "/api/accounts/home", { codexHome: args.codexHome });
    case "import_account_json":
      return api<T>("POST", "/api/accounts/import", { content: args.content });
    case "import_account_docs":
      throw new Error("En mode SaaS, colle le contenu JSON plutot qu'un chemin de fichier local.");
    case "remove_account":
      return api<T>("DELETE", `/api/accounts/${encodeURIComponent(args.accountId)}`);
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
    case "write_terminal":
      writeRemoteTerminal(args.id, args.data);
      return undefined as T;
    case "resize_terminal":
      resizeRemoteTerminal(args.id, args.cols, args.rows);
      return undefined as T;
    case "stop_terminal":
      stopRemoteTerminal(args.id);
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
    case "delete_discussion":
      return api<T>("POST", "/api/discussions/delete", {
        accountId: args.accountId,
        sessionId: args.sessionId,
        archive: args.archive,
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
  const payload = {
    id: args.id,
    accountId: args.accountId,
    repoUrl: args.repoUrl,
    branch: args.branch,
    cols: args.cols,
    rows: args.rows,
    command: args.command,
    agentId: args.agentId,
  };
  const candidates = await terminalNodeCandidates();
  let lastError: unknown = null;

  for (const route of candidates) {
    try {
      const response = await apiAt<RemoteStartResponse>(route, "POST", "/api/terminals", payload);
      remoteTerminalRoutes.set(response.id, route);
      emit("pty-data", {
        id: response.id,
        data: `\r\n[Route] Terminal sur ${route.label} (${route.baseUrl})\r\n`,
      });
      openTerminalSocket(response.id, route);
      return response.id as T;
    } catch (error) {
      lastError = error;
    }
  }

  throw lastError ?? new Error("Aucun noeud terminal disponible.");
}

function openTerminalSocket(id: number, route = remoteTerminalRoutes.get(id) ?? defaultRemoteRoute()) {
  remoteSockets.get(id)?.close();
  const base = route.baseUrl;
  const wsBase = base.startsWith("https://")
    ? base.replace(/^https:\/\//, "wss://")
    : base.replace(/^http:\/\//, "ws://");
  const socket = new WebSocket(`${wsBase}/ws/terminals/${id}?token=${encodeURIComponent(route.token)}`);
  remoteSockets.set(id, socket);

  socket.addEventListener("message", (event) => {
    const message = JSON.parse(String(event.data)) as RemoteWsMessage;
    if (message.type === "data") {
      emit("pty-data", { id: message.id, data: message.data });
    } else if (message.type === "exit") {
      remoteSockets.delete(message.id);
      remoteTerminalRoutes.delete(message.id);
      emit("pty-exit", { id: message.id });
    } else if (message.type === "error") {
      emit("pty-data", { id: message.id, data: `\r\n${message.message}\r\n` });
    } else if (message.type === "status") {
      // Le message WS "status" peut arriver en camelCase (workspacePath) ou en
      // snake_case (workspace_path) selon la version du noeud : on tolere les
      // deux pour ne pas afficher "undefined" (utile aussi pendant une mise a
      // jour rolling ou d'anciens et nouveaux noeuds coexistent).
      const workspacePath =
        message.workspacePath ?? (message as unknown as { workspace_path?: string }).workspace_path ?? "";
      emit("pty-data", {
        id: message.id,
        data: `\r\n[Workspace] ${workspacePath}\r\n`,
      });
    }
  });

  socket.addEventListener("close", () => {
    remoteSockets.delete(id);
  });
}

function writeRemoteTerminal(id: number, data: string) {
  const socket = remoteSockets.get(id);
  if (socket?.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify({ type: "input", data }));
    return;
  }
  const route = remoteTerminalRoutes.get(id) ?? defaultRemoteRoute();
  void apiAt(route, "POST", `/api/terminals/${id}/write`, { data }).catch((error) => {
    emit("pty-data", { id, data: `\r\n${String(error)}\r\n` });
  });
}

function resizeRemoteTerminal(id: number, cols: number, rows: number) {
  const socket = remoteSockets.get(id);
  if (socket?.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify({ type: "resize", cols, rows }));
    return;
  }
  const route = remoteTerminalRoutes.get(id) ?? defaultRemoteRoute();
  void apiAt(route, "POST", `/api/terminals/${id}/resize`, { cols, rows }).catch(() => undefined);
}

function stopRemoteTerminal(id: number) {
  const socket = remoteSockets.get(id);
  if (socket?.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify({ type: "stop" }));
    socket.close();
  }
  const route = remoteTerminalRoutes.get(id) ?? defaultRemoteRoute();
  void apiAt(route, "DELETE", `/api/terminals/${id}`).catch(() => undefined);
  remoteTerminalRoutes.delete(id);
}

function emit<T>(event: string, payload: T) {
  listeners.get(event)?.forEach((handler) => handler({ payload }));
}
