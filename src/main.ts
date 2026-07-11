import {
  appWindow,
  hasRemoteAuth,
  initializePlatform,
  invoke,
  isRemoteMode,
  listen,
  remoteBaseUrl,
  remoteNodesText,
  saveRemoteConfig,
  type UnlistenFn,
} from "./platform";
import { initDesktopUpdater } from "./updater";
import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import {
  AppWindow,
  BadgeCheck,
  BarChart3,
  Bot,
  CalendarClock,
  CircleDollarSign,
  Clock3,
  FlaskConical,
  FolderOpen,
  History,
  Maximize2,
  Minimize2,
  Play,
  PlugZap,
  Plus,
  Power,
  RefreshCcw,
  Save,
  Server,
  Shuffle,
  SquareTerminal,
  Stethoscope,
  Trash2,
  Upload,
  Users,
  X,
  Copy,
  MessagesSquare,
  Search,
  Send,
  createIcons,
} from "lucide";
import "@xterm/xterm/css/xterm.css";
import "./style.css";

type AccountProfile = {
  id: string;
  label: string;
  codexHome: string;
  projectDir?: string | null;
  proxyId?: string | null;
  startupCommand?: string | null;
  limits?: AccountLimitTracking;
  // Bypass Codex par compte (defaut ON). Absent des configs anterieures : on
  // retombe alors sur le defaut global `codexBypass`, puis `true`.
  bypass?: boolean;
};

type AccountLimitTracking = {
  connectedAt?: number | null;
  sessionAnchorAt?: number | null;
  weeklyAnchorAt?: number | null;
};

type ProxyProfile = {
  id: string;
  label: string;
  proxyUrl: string;
  note?: string | null;
};

type AgentKind = "cli" | "ide";

type AgentProfile = {
  id: string;
  label: string;
  command: string;
  kind?: AgentKind;
  builtin?: boolean;
  loginCommand?: string | null;
  statusCommand?: string | null;
  doctorCommand?: string | null;
};

// Lanceurs d'editeurs connus qui hebergent l'extension Kombai. Tous ouvrent un
// dossier via `<cmd> <chemin>`.
const KNOWN_IDE_COMMANDS = ["code", "cursor", "windsurf", "trae", "antigravity", "kiro"];

type KombaiConfig = {
  codeServerCommand: string;
  port: number;
  extensionId: string;
  autoInstallExtension: boolean;
};

type KombaiStatus = {
  running: boolean;
  started: boolean;
  url?: string | null;
  port: number;
  projectDir?: string | null;
  command: string;
  binaryAvailable: boolean;
  extensionId: string;
  message?: string | null;
};

type AgentRoomConfig = {
  enabled: boolean;
  port: number;
  secret: string;
};

// Entree/reponse du navigateur de dossiers du serveur (mode web). En desktop on
// utilise le dialogue natif (`pick_project_dir`), pas cette API.
type FsEntry = { name: string; path: string; isDir: boolean };
type FsListResponse = {
  root: string;
  path: string;
  parent: string | null;
  entries: FsEntry[];
};

type AppSettings = {
  accounts: AccountProfile[];
  proxies: ProxyProfile[];
  defaultAccountId?: string | null;
  shell: string;
  codexCommand: string;
  autoRunCodex: boolean;
  proxyControlsEnabled: boolean;
  pool: PoolConfig;
  agents: AgentProfile[];
  activeAgentId?: string | null;
  kombai: KombaiConfig;
  agentRoom: AgentRoomConfig;
  codexBypass: boolean;
  autoDiscoverAccounts: boolean;
};

type RoomAgent = {
  ident: string;
  agentId: string;
  accountId: string;
  label: string;
  cwd?: string | null;
  present: boolean;
  joinedAt: number;
  lastSeen: number;
};

type RoomMessage = {
  id: number;
  ts: number;
  from: string;
  fromLabel: string;
  to?: string | null;
  kind: "room" | "dm" | "system";
  text: string;
};

type RoomStatus = {
  running: boolean;
  port: number;
  url: string;
  snapshot: {
    agents: RoomAgent[];
    present: number;
    totalMessages: number;
    cursor: number;
  };
};

type PoolConfig = {
  port: number;
  apiKey: string;
  defaultModel: string;
  reasoningEffort: string;
  upstream: string;
  requestTimeoutSecs: number;
  cooldownSecs429: number;
  concurrency: number;
  clientIdOverride: string;
};

type PoolAccountView = {
  id: string;
  label: string;
  codexHome: string;
  hasProxy: boolean;
  proxyMasked: string;
  accountId: string;
  hasTokens: boolean;
  hasRefreshToken: boolean;
  oauthClient: string;
  accessExp?: number | null;
  status: string;
  cooldownUntil?: number | null;
  lastUsed?: number | null;
  served: number;
  errors: number;
  lastError?: string | null;
};

type PoolStatus = {
  running: boolean;
  startedAt?: number;
  baseUrl?: string;
  model?: string;
  upstream?: string;
  total?: number;
  idle?: number;
  accounts?: PoolAccountView[];
};

type UsageDayView = {
  date: string;
  agentRunSeconds: number;
  agentRuns: number;
  apiRequests: number;
  apiErrors: number;
  apiSeconds: number;
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  totalTokens: number;
  estimatedRequests: number;
  costUsd: number;
};

type UsageDashboard = {
  generatedAt: number;
  totalAgentSeconds: number;
  totalAgentRuns: number;
  activeAgentCount: number;
  totalApiRequests: number;
  totalApiErrors: number;
  totalTokens: number;
  totalCostUsd: number;
  today: UsageDayView;
  days: UsageDayView[];
};

type AccountUsageDay = {
  date: string;
  sessions: number;
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  reasoningOutputTokens: number;
  totalTokens: number;
  costUsd: number;
};

type AccountUsageView = {
  id: string;
  label: string;
  codexHome: string;
  hasTokens: boolean;
  sessionCount: number;
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  reasoningOutputTokens: number;
  totalTokens: number;
  costUsd: number;
  todayTokens: number;
  todayCostUsd: number;
  monthTokens: number;
  monthCostUsd: number;
  firstActivity?: number | null;
  lastActivity?: number | null;
  days: AccountUsageDay[];
  error?: string | null;
};

type AccountUsageDashboard = {
  generatedAt: number;
  totalTokens: number;
  totalCostUsd: number;
  totalSessions: number;
  accounts: AccountUsageView[];
};

type AccountLimitView = {
  id: string;
  label: string;
  codexHome: string;
  hasTokens: boolean;
  connectedAt?: number | null;
  sessionResetAt?: number | null;
  weeklyResetAt?: number | null;
  sessionRemainingSecs?: number | null;
  weeklyRemainingSecs?: number | null;
  sessionUsedPercent?: number | null;
  weeklyUsedPercent?: number | null;
  buckets: AccountRateLimitBucketView[];
  refreshedAt?: number | null;
  source: string;
  error?: string | null;
};

type AccountRateLimitBucketView = {
  limitId: string;
  limitName?: string | null;
  bucket: string;
  windowDurationMins: number;
  resetsAt: number;
  usedPercent?: number | null;
  rateLimitReachedType?: string | null;
  planType?: string | null;
};

type PtyDataEvent = {
  id: number;
  data: string;
};

type PtyExitEvent = {
  id: number;
};

type TerminalSession = {
  key: string;
  ptyId: number | null;
  accountId: string;
  agentId: string;
  title: string;
  projectDir: string | null;
  proxySummary: string;
  status: string;
  running: boolean;
  startedAtUnix: number | null;
  codexSessionId: string | null;
  resumeSessionId: string | null;
  sessionCaptureDone: boolean;
  terminal: Terminal;
  fitAddon: FitAddon;
};

type PersistedTerminalRecord = {
  key: string;
  accountId: string;
  agentId: string;
  codexSessionId?: string | null;
  projectDir?: string | null;
};

type PersistedTerminalState = {
  v: 2;
  activeKey: string | null;
  terminals: PersistedTerminalRecord[];
};

type AppView =
  | "terminal"
  | "pool"
  | "limits"
  | "dashboard"
  | "kombai"
  | "discussions"
  | "history"
  | "room";

type DiscussionSummary = {
  // Identite LOGIQUE de la conversation (stable a travers les reprises/forks).
  // Sert de cle de regroupement et de suppression.
  sessionId: string;
  // Identite du fichier rollout HEAD (le plus recent). Cible de `codex resume`
  // et de la copie vers un autre compte.
  rolloutId: string;
  // Nombre de fichiers rollout regroupes sous ce sessionId (>1 = repris).
  forkCount: number;
  accountId: string;
  accountLabel: string;
  codexHome: string;
  filePath: string;
  cwd: string | null;
  startedAt: number;
  lastActivity: number;
  title: string | null;
  preview: string | null;
  messageCount: number;
  totalTokens: number | null;
  cliVersion: string | null;
};

type DiscussionAccountGroup = {
  accountId: string;
  label: string;
  codexHome: string;
  hasTokens: boolean;
  discussionCount: number;
  discussions: DiscussionSummary[];
  error?: string | null;
};

type DiscussionsView = {
  generatedAt: number;
  totalDiscussions: number;
  accounts: DiscussionAccountGroup[];
};

type PromptEntry = {
  sessionId: string;
  accountId: string;
  accountLabel: string;
  codexHome: string;
  filePath: string;
  cwd: string | null;
  timestamp: number;
  sessionTitle: string | null;
  text: string;
};

type PromptHistoryView = {
  generatedAt: number;
  totalPrompts: number;
  returned: number;
  truncated: boolean;
  prompts: PromptEntry[];
};

const app = document.querySelector<HTMLDivElement>("#app");

if (!app) {
  throw new Error("Missing #app");
}

let settings: AppSettings | null = null;
let selectedAccountId: string | null = null;
let activeTerminalKey: string | null = null;
let statusText = "Pret";
let ptyIdSeed = Date.now();
let terminalSessions: TerminalSession[] = [];
let unlistenData: UnlistenFn | null = null;
let unlistenExit: UnlistenFn | null = null;
let activeView: AppView = "terminal";
let poolStatus: PoolStatus | null = null;
let poolPoll: number | null = null;
let poolImportPaths = "";
let poolNewAccountLabel = "";
let poolNewAccountProxyId = "";
let pendingDeleteAccountId: string | null = null;
let limitStatus: AccountLimitView[] = [];
let limitStatusLoaded = false;
let limitPoll: number | null = null;
let usageDashboard: UsageDashboard | null = null;
let usageLoaded = false;
let usagePoll: number | null = null;
let accountUsage: AccountUsageDashboard | null = null;
let accountUsageLoaded = false;
let kombaiStatus: KombaiStatus | null = null;
let kombaiLoaded = false;
let kombaiPoll: number | null = null;
let kombaiStatusError = false;
let isFullscreen = false;
let newTerminalModalOpen = false;
let newTerminalAccountId: string | null = null;
let newTerminalAgentId: string | null = null;
let agentsModalOpen = false;
let discussions: DiscussionsView | null = null;
let discussionsLoaded = false;
let discussionsPoll: number | null = null;
let discussionSearch = "";
// Compte cible choisi par discussion (sessionId -> accountId). Defaut : le
// compte d'origine. Persiste entre les re-rendus (poll 60s) pour ne pas perdre
// le choix en cours.
const discussionTargetSel = new Map<string, string>();
let discussionBusyId: string | null = null;
let promptHistory: PromptHistoryView | null = null;
let promptHistoryLoaded = false;
let promptSearch = "";
let roomStatus: RoomStatus | null = null;
let roomMessages: RoomMessage[] = [];
let roomPoll: number | null = null;
// Destinataire choisi dans le composer : "" = diffusion salon, sinon ident d'un
// agent (DM). Conserve entre les rendus complets.
let roomComposeTarget = "";
// Selecteur de workspace (mode web) : modale de navigation de dossiers serveur.
let workspaceModalOpen = false;
let workspaceBrowse: FsListResponse | null = null;
let workspaceBrowseLoading = false;
let workspaceBrowseError = "";

const lucideIcons = {
  AppWindow,
  BadgeCheck,
  BarChart3,
  Bot,
  CalendarClock,
  CircleDollarSign,
  Clock3,
  FlaskConical,
  FolderOpen,
  History,
  Maximize2,
  Minimize2,
  Play,
  PlugZap,
  Plus,
  Power,
  RefreshCcw,
  Save,
  Server,
  Shuffle,
  SquareTerminal,
  Stethoscope,
  Trash2,
  Upload,
  Users,
  X,
  Copy,
  MessagesSquare,
  Search,
  Send,
};

const OPEN_TERMINALS_STORAGE_KEY = "codex-switch-terminal.open-terminals.v2";

// Workspace courant = dossier de travail (cwd) applique aux PROCHAINS agents.
// Memorise par appareil (localStorage) : chaque navigateur/PC garde son propre
// choix. En web c'est un dossier du serveur ; en desktop un dossier local.
const WORKSPACE_STORAGE_KEY = "codex-switch-terminal.workspace.path";

const currentWorkspace = (): string | null =>
  localStorage.getItem(WORKSPACE_STORAGE_KEY)?.trim() || null;

const setCurrentWorkspace = (path: string | null) => {
  const trimmed = path?.trim();
  if (trimmed) {
    localStorage.setItem(WORKSPACE_STORAGE_KEY, trimmed);
  } else {
    localStorage.removeItem(WORKSPACE_STORAGE_KEY);
  }
};

// Dernier segment d'un chemin (nom du dossier) pour un affichage compact.
const workspaceBaseName = (path: string): string =>
  path.replace(/[\\/]+$/, "").split(/[\\/]/).pop() || path;

const uid = (prefix: string) =>
  `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;

const EMPTY_TERMINAL_STATE: PersistedTerminalState = { v: 2, activeKey: null, terminals: [] };

const loadOpenTerminalRecords = (): PersistedTerminalState => {
  try {
    const raw = localStorage.getItem(OPEN_TERMINALS_STORAGE_KEY);
    if (!raw) return { ...EMPTY_TERMINAL_STATE };
    const parsed = JSON.parse(raw);
    if (!parsed || !Array.isArray(parsed.terminals)) return { ...EMPTY_TERMINAL_STATE };

    const terminals = parsed.terminals
      .map((item: any): PersistedTerminalRecord | null => {
        if (!item || typeof item.key !== "string" || typeof item.accountId !== "string") {
          return null;
        }
        return {
          key: item.key,
          accountId: item.accountId,
          agentId: typeof item.agentId === "string" ? item.agentId : "codex",
          codexSessionId: typeof item.codexSessionId === "string" ? item.codexSessionId : null,
          projectDir: typeof item.projectDir === "string" ? item.projectDir : null,
        };
      })
      .filter((item: PersistedTerminalRecord | null): item is PersistedTerminalRecord => item !== null);

    return {
      v: 2,
      activeKey: typeof parsed.activeKey === "string" ? parsed.activeKey : null,
      terminals,
    };
  } catch {
    return { ...EMPTY_TERMINAL_STATE };
  }
};

const saveOpenTerminalRecords = (state: PersistedTerminalState) => {
  localStorage.setItem(OPEN_TERMINALS_STORAGE_KEY, JSON.stringify(state));
};

const persistTerminalSessions = () => {
  saveOpenTerminalRecords({
    v: 2,
    activeKey: activeTerminalKey,
    terminals: terminalSessions
      .filter((session) => session.status !== "Ferme")
      .map((session) => ({
        key: session.key,
        accountId: session.accountId,
        agentId: session.agentId,
        codexSessionId: session.codexSessionId,
        projectDir: session.projectDir,
      })),
  });
};

// --- Reprise des discussions Codex ---------------------------------------
// Un rollout Codex = une discussion (rollout-<ts>-<uuid>.jsonl). On garde
// l'uuid (session id) pour relancer `codex resume <uuid>` a la reouverture.
const UUID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
const isPlausibleSessionId = (id: string | null | undefined): id is string => !!id && UUID_RE.test(id);

// Le flag bypass Codex depend du compte et doit preceder la sous-commande
// `resume`. On passe le compte cible pour respecter son reglage bypass.
const buildResumeCommand = (id: string, account: AccountProfile | null | undefined = null) =>
  `${agentRunCommand(agentById(codexAgentId()), account)} resume ${id}`;

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const SESSION_CAPTURE_DELAYS_MS = [1200, 2000, 3000, 4500, 7000, 10000];

// Ids de sessions Codex deja attribues a un terminal (capture ou reprise). Sert
// a garantir qu'un meme rollout n'est jamais revendique par deux terminaux.
const claimedSessionIds = new Set<string>();
// File d'attente serialisant les appels claim_session_for_terminal : deux
// captures simultanees ne doivent pas revendiquer le meme rollout en meme
// temps. Chaque claim voit les ids deja pris et enregistre le sien avant le
// claim suivant.
let claimQueue: Promise<unknown> = Promise.resolve();

const claimSessionForTerminal = (session: TerminalSession): Promise<string | null> => {
  const run = async (): Promise<string | null> => {
    if (session.sessionCaptureDone || session.codexSessionId) return null;
    if (!terminalSessions.includes(session) || session.ptyId === null) return null;
    const afterUnix = session.startedAtUnix ?? Math.floor(Date.now() / 1000);
    const exclude = Array.from(
      new Set<string>([
        ...claimedSessionIds,
        ...terminalSessions
          .filter((other) => other !== session && other.codexSessionId)
          .map((other) => other.codexSessionId as string),
      ]),
    );
    const id = await invoke<string | null>("claim_session_for_terminal", {
      accountId: session.accountId,
      afterUnix,
      excludeSessionIds: exclude,
      matchSessionId: session.resumeSessionId,
    });
    if (id) claimedSessionIds.add(id);
    return id;
  };
  const result = claimQueue.then(run, run);
  claimQueue = result.then(
    () => undefined,
    () => undefined,
  );
  return result;
};

// Apres le lancement de Codex dans un terminal, retrouve l'uuid du rollout que
// Codex vient de creer afin de l'associer a ce terminal (puis le persister).
const captureCodexSessionId = async (session: TerminalSession) => {
  if (session.sessionCaptureDone) return;

  for (const delay of SESSION_CAPTURE_DELAYS_MS) {
    if (!terminalSessions.includes(session) || session.ptyId === null) return;
    await sleep(delay);
    if (!terminalSessions.includes(session) || session.ptyId === null) return;

    try {
      const id = await claimSessionForTerminal(session);
      if (id) {
        session.codexSessionId = id;
        session.sessionCaptureDone = true;
        persistTerminalSessions();
        return;
      }
    } catch {
      // transitoire : on retente au prochain delai
    }
  }

  if (session.resumeSessionId && !session.codexSessionId) {
    session.codexSessionId = session.resumeSessionId;
    claimedSessionIds.add(session.resumeSessionId);
  }
  session.sessionCaptureDone = true;
  persistTerminalSessions();
};

const reservePtyId = () => {
  ptyIdSeed += 1;
  return ptyIdSeed;
};

const waitForFrame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));

const selectedAccount = () =>
  settings?.accounts.find((account) => account.id === selectedAccountId) ?? null;

const newTerminalAccount = () =>
  settings?.accounts.find((account) => account.id === newTerminalAccountId) ?? null;

const agentById = (id: string | null | undefined) =>
  settings?.agents.find((agent) => agent.id === id) ?? null;

const accountById = (id: string | null | undefined) =>
  settings?.accounts.find((account) => account.id === id) ?? null;

const activeAgent = () => agentById(settings?.activeAgentId) ?? settings?.agents[0] ?? null;

const newTerminalAgent = () => agentById(newTerminalAgentId) ?? activeAgent();

// L'id de l'agent Codex integre : le pool (comptes Codex + OAuth ChatGPT) doit
// toujours lancer Codex, quel que soit l'agent actif dans la barre d'outils.
const codexAgentId = () =>
  settings?.agents.find((agent) => agent.id === "codex")?.id ??
  settings?.agents.find((agent) => agent.builtin)?.id ??
  "codex";

const agentCommand = (agent: AgentProfile | null | undefined) => agent?.command.trim() || "codex";

// Seul l'agent Codex integre recoit le flag bypass ; un agent CLI generique
// (autre binaire) ne comprendrait pas ce flag.
const isCodexAgent = (agent: AgentProfile | null | undefined) =>
  agent?.id === "codex" || agent?.builtin === true;

const CODEX_BYPASS_FLAG = "--dangerously-bypass-approvals-and-sandbox";

// Le bypass est un reglage PAR COMPTE (defaut ON). Un compte sans champ `bypass`
// (config anterieure) retombe sur le defaut global `codexBypass`, puis `true`.
const accountBypassEnabled = (account: AccountProfile | null | undefined) =>
  account?.bypass ?? settings?.codexBypass ?? true;

// Commande a taper dans le PTY pour lancer un agent. Pour Codex, ajoute le flag
// bypass quand le compte concerne l'a active (defaut), sauf s'il est deja
// present dans une commande personnalisee.
const agentRunCommand = (
  agent: AgentProfile | null | undefined,
  account: AccountProfile | null | undefined = null,
) => {
  const base = agentCommand(agent);
  if (isCodexAgent(agent) && accountBypassEnabled(account) && !base.includes(CODEX_BYPASS_FLAG)) {
    return `${base} ${CODEX_BYPASS_FLAG}`;
  }
  return base;
};

const agentIsIde = (agent: AgentProfile | null | undefined) => agent?.kind === "ide";

// Dossier projet a ouvrir pour un agent IDE / Kombai : le workspace choisi est
// prioritaire (choix explicite global), sinon le dossier du terminal actif,
// sinon celui du compte selectionne.
const currentProjectDir = () =>
  currentWorkspace() ?? activeTerminal()?.projectDir ?? selectedAccount()?.projectDir?.trim() ?? null;

const launchIde = async (agent: AgentProfile, projectDir: string | null = currentProjectDir()) => {
  try {
    await invoke("launch_ide", { command: agentCommand(agent), projectDir });
    statusText = projectDir
      ? `${agent.label} ouvert dans ${agent.command} (${projectDir})`
      : `${agent.label} ouvert dans ${agent.command}`;
  } catch (error) {
    statusText = String(error);
  }
  render();
};

const agentSubcommand = (agent: AgentProfile | null | undefined, sub?: string | null) => {
  const base = agentCommand(agent);
  const suffix = sub?.trim();
  return suffix ? `${base} ${suffix}` : base;
};

const setActiveAgent = (id: string | null) => {
  if (!settings) return;
  if (!settings.agents.some((agent) => agent.id === id)) return;
  settings.activeAgentId = id;
  const agent = agentById(id);
  statusText = agent ? `Agent actif: ${agent.label}` : "Agent actif";
  render();
  void invoke<AppSettings>("save_settings", { settings }).catch(() => undefined);
};

const proxyControlsEnabled = () => settings?.proxyControlsEnabled ?? true;

const proxyForAccount = (account: AccountProfile | null) =>
  proxyControlsEnabled() ? (settings?.proxies.find((proxy) => proxy.id === account?.proxyId) ?? null) : null;

const selectedProxy = () => proxyForAccount(selectedAccount());

const activeTerminal = () =>
  terminalSessions.find((session) => session.key === activeTerminalKey) ?? null;

const fitAndResizeActiveTerminal = () => {
  const session = activeTerminal();
  if (!session) return;

  session.fitAddon.fit();

  if (session.ptyId !== null) {
    void invoke("resize_terminal", {
      id: session.ptyId,
      cols: session.terminal.cols,
      rows: session.terminal.rows,
    }).catch(() => undefined);
  }
};

const projectFieldLabel = () => (isRemoteMode() ? "Repo Git optionnel" : "Dossier projet");
const projectFieldPlaceholder = () =>
  isRemoteMode() ? "https://github.com/org/repo.git" : "C:\\chemin\\vers\\projet";
const displayProjectDir = (projectDir?: string | null) =>
  projectDir?.trim() || (isRemoteMode() ? "workspace vide" : "dossier par defaut");

const maskProxy = (value: string) =>
  value.replace(/:\/\/([^:@/]+):([^@/]+)@/, "://$1:***@");

const toggleFullscreen = async () => {
  try {
    const nextFullscreen = !(await appWindow.isFullscreen());
    await appWindow.setFullscreen(nextFullscreen);
    isFullscreen = nextFullscreen;
    statusText = nextFullscreen ? "Mode plein ecran" : "Mode fenetre";
    render();
    await waitForFrame();
    fitAndResizeActiveTerminal();
  } catch (error) {
    statusText = String(error);
    render();
  }
};

const saveSettings = async () => {
  if (!settings) return;
  settings.defaultAccountId = selectedAccountId;
  settings = await invoke<AppSettings>("save_settings", { settings });
  statusText = "Configuration enregistree";
  render();
};

const readPoolForm = () => {
  if (!settings) return;
  const port = Number(document.querySelector<HTMLInputElement>("#poolPort")?.value);
  if (Number.isFinite(port) && port > 0) settings.pool.port = port;
  settings.pool.defaultModel =
    document.querySelector<HTMLInputElement>("#poolModel")?.value.trim() || settings.pool.defaultModel;
  settings.pool.reasoningEffort =
    document.querySelector<HTMLInputElement>("#poolEffort")?.value.trim() || settings.pool.reasoningEffort;
  settings.pool.apiKey = document.querySelector<HTMLInputElement>("#poolApiKey")?.value ?? "";
  settings.pool.upstream =
    document.querySelector<HTMLInputElement>("#poolUpstream")?.value.trim() || settings.pool.upstream;
  poolImportPaths = document.querySelector<HTMLTextAreaElement>("#poolImportPaths")?.value ?? poolImportPaths;
};

const startPool = async () => {
  if (!settings) return;
  readPoolForm();
  try {
    settings = await invoke<AppSettings>("save_settings", { settings });
    poolStatus = await invoke<PoolStatus>("pool_start");
    statusText = `Pool actif sur ${poolStatus.baseUrl ?? ""}`;
    startPoolPoll();
  } catch (error) {
    statusText = String(error);
  }
  render();
};

const stopPool = async () => {
  try {
    poolStatus = await invoke<PoolStatus>("pool_stop");
    stopPoolPoll();
    statusText = "Pool arrete";
  } catch (error) {
    statusText = String(error);
  }
  render();
};

const refreshPoolStatus = async () => {
  try {
    poolStatus = await invoke<PoolStatus>("pool_status");
  } catch {
    return;
  }
  if (activeView === "pool" && poolStatus?.running) {
    const rows = document.querySelector<HTMLTableSectionElement>("#poolRows");
    if (rows) {
      rows.innerHTML = poolStatus.accounts?.map(renderPoolRow).join("") ?? "";
      createIcons({ icons: lucideIcons });
    } else {
      render();
    }
  }
};

const startPoolPoll = () => {
  stopPoolPoll();
  poolPoll = window.setInterval(() => void refreshPoolStatus(), 3000);
};

const stopPoolPoll = () => {
  if (poolPoll !== null) {
    clearInterval(poolPoll);
    poolPoll = null;
  }
};

// ---------------------------------------------------------------------------
// Salon d'agents (Agent Room)
// ---------------------------------------------------------------------------

const roomPresentAgents = (): RoomAgent[] =>
  roomStatus?.snapshot.agents.filter((agent) => agent.present) ?? [];

const roomAgentLabel = (ident: string): string => {
  if (ident === "operator") return "Opérateur";
  return roomStatus?.snapshot.agents.find((agent) => agent.ident === ident)?.label ?? ident;
};

const renderRoomAgentsInner = (): string => {
  const agents = roomPresentAgents();
  if (!agents.length) return `<div class="empty">Aucun agent présent</div>`;
  return agents
    .map(
      (agent) => `
        <div class="room-agent">
          <span class="live-dot on"></span>
          <div class="room-agent-main">
            <strong>${escapeHtml(agent.label)}</strong>
            <small>${escapeHtml(agent.ident)}${agent.cwd ? ` · ${escapeHtml(agent.cwd)}` : ""}</small>
          </div>
        </div>`,
    )
    .join("");
};

const renderRoomFeedInner = (): string => {
  if (!roomMessages.length) return `<div class="empty">Aucun message pour l'instant</div>`;
  return roomMessages
    .map((message) => {
      if (message.kind === "system") {
        return `<div class="room-msg system"><em>${escapeHtml(message.text)}</em></div>`;
      }
      const target = message.to ? ` → ${escapeHtml(roomAgentLabel(message.to))}` : "";
      const tag = message.kind === "dm" ? ` <span class="room-tag">privé</span>` : "";
      return `
        <div class="room-msg ${message.kind}">
          <div class="room-msg-head"><strong>${escapeHtml(message.fromLabel)}</strong>${target}${tag}</div>
          <div class="room-msg-body">${escapeHtml(message.text)}</div>
        </div>`;
    })
    .join("");
};

const roomTargetOptions = (): string =>
  roomPresentAgents()
    .map(
      (agent) =>
        `<option value="${escapeAttr(agent.ident)}" ${agent.ident === roomComposeTarget ? "selected" : ""}>${escapeHtml(agent.label)} (privé)</option>`,
    )
    .join("");

const renderRoomPanel = (): string => {
  const enabled = settings?.agentRoom?.enabled ?? false;
  const running = roomStatus?.running ?? false;
  const present = roomStatus?.snapshot.present ?? 0;
  const sub = enabled
    ? `${running ? `Actif · ${escapeHtml(roomStatus?.url ?? "")}` : "Serveur arrêté"} · ${present} agent(s) présent(s)`
    : "Désactivé";
  return `
    <div class="panel room-panel">
      <div class="panel-head">
        <div>
          <h2>Salon d'agents</h2>
          <p class="panel-sub">${sub}</p>
        </div>
        <div class="panel-actions">
          <button id="roomRefresh" class="icon-button wide" title="Rafraîchir"><i data-lucide="refresh-ccw"></i></button>
          <button id="roomToggleEnabled" class="tool-button ${enabled ? "primary" : ""}" title="${enabled ? "Désactiver le salon" : "Activer le salon"}">
            <i data-lucide="power"></i><span>${enabled ? "Activé" : "Désactivé"}</span>
          </button>
        </div>
      </div>
      ${
        enabled
          ? ""
          : `<div class="room-hint">Active le salon pour que les agents Codex se voient et se parlent (outils MCP <code>list_agents</code>, <code>send_message</code>, <code>read_messages</code>). L'app ajoute une entrée <code>agent_room</code> dans le <code>config.toml</code> de chaque compte au lancement d'un terminal — réversible à la désactivation.</div>`
      }
      <div class="room-grid">
        <aside class="room-agents">
          <div class="section-row"><span>Présents</span></div>
          <div id="roomAgents">${renderRoomAgentsInner()}</div>
        </aside>
        <div class="room-main">
          <div id="roomFeed" class="room-feed">${renderRoomFeedInner()}</div>
          <form id="roomComposer" class="room-composer">
            <select id="roomTarget" class="agent-select" title="Destinataire" aria-label="Destinataire">
              <option value="">Salon (tous)</option>
              ${roomTargetOptions()}
            </select>
            <input id="roomText" type="text" placeholder="Message en tant qu'opérateur…" autocomplete="off" />
            <button type="submit" class="tool-button primary" title="Envoyer"><i data-lucide="send"></i><span>Envoyer</span></button>
          </form>
        </div>
      </div>
    </div>`;
};

const syncRoomTargetOptions = () => {
  const select = document.querySelector<HTMLSelectElement>("#roomTarget");
  if (!select) return;
  // Ne reconstruit que si le nombre d'agents a change (evite de casser une
  // selection en cours d'ouverture a chaque poll).
  if (select.options.length - 1 === roomPresentAgents().length) return;
  const current = select.value;
  select.innerHTML = `<option value="">Salon (tous)</option>${roomTargetOptions()}`;
  select.value = current;
};

const refreshRoom = async () => {
  try {
    roomStatus = await invoke<RoomStatus>("room_status");
  } catch {
    return;
  }
  try {
    const result = await invoke<{ messages: RoomMessage[]; cursor: number }>("room_messages", {
      since: 0,
    });
    roomMessages = result.messages ?? [];
  } catch {
    // le fil reste tel quel
  }
  if (activeView !== "room") return;
  const agentsEl = document.querySelector<HTMLDivElement>("#roomAgents");
  const feedEl = document.querySelector<HTMLDivElement>("#roomFeed");
  if (agentsEl && feedEl) {
    const atBottom = feedEl.scrollHeight - feedEl.scrollTop - feedEl.clientHeight < 40;
    agentsEl.innerHTML = renderRoomAgentsInner();
    feedEl.innerHTML = renderRoomFeedInner();
    syncRoomTargetOptions();
    createIcons({ icons: lucideIcons });
    if (atBottom) feedEl.scrollTop = feedEl.scrollHeight;
  } else {
    render();
  }
};

const startRoomPoll = () => {
  stopRoomPoll();
  roomPoll = window.setInterval(() => void refreshRoom(), 2000);
};

const stopRoomPoll = () => {
  if (roomPoll !== null) {
    clearInterval(roomPoll);
    roomPoll = null;
  }
};

const enableRoom = async () => {
  try {
    await invoke("room_enable", {});
    if (settings) settings.agentRoom.enabled = true;
    statusText = "Salon activé";
  } catch (error) {
    statusText = String(error);
  }
  await refreshRoom();
  render();
};

const disableRoom = async () => {
  try {
    await invoke("room_disable");
    if (settings) settings.agentRoom.enabled = false;
    statusText = "Salon désactivé";
  } catch (error) {
    statusText = String(error);
  }
  await refreshRoom();
  render();
};

const sendRoomMessage = async () => {
  const input = document.querySelector<HTMLInputElement>("#roomText");
  const target = document.querySelector<HTMLSelectElement>("#roomTarget");
  const text = input?.value.trim() ?? "";
  if (!text) return;
  const to = target?.value || null;
  try {
    await invoke("room_send", { text, to });
    if (input) input.value = "";
  } catch (error) {
    statusText = String(error);
    render();
    return;
  }
  await refreshRoom();
};

const removeAccount = async (id: string | null) => {
  if (!settings || !id) return;
  const account = settings.accounts.find((candidate) => candidate.id === id);
  if (!account) return;

  pendingDeleteAccountId = null;
  try {
    settings = await invoke<AppSettings>("remove_account", { accountId: id });
    if (selectedAccountId === id) {
      selectedAccountId = settings.defaultAccountId ?? settings.accounts[0]?.id ?? null;
    }
    if (poolStatus?.running) {
      poolStatus = await invoke<PoolStatus>("pool_start");
      startPoolPoll();
    } else {
      poolStatus = await invoke<PoolStatus>("pool_status");
    }
    statusText = `Compte « ${account.label} » retiré du pool`;
  } catch (error) {
    statusText = String(error);
  }
  render();
};

const setActiveView = (view: AppView) => {
  activeView = activeView === view ? "terminal" : view;
  statusText =
    activeView === "pool"
      ? "Vue pool"
      : activeView === "limits"
        ? "Vue limites"
        : activeView === "dashboard"
          ? "Vue dashboard"
          : activeView === "kombai"
            ? "Vue Kombai"
            : activeView === "discussions"
              ? "Vue discussions"
              : activeView === "history"
                ? "Vue historique"
                : activeView === "room"
                  ? "Vue salon"
                  : "Vue terminal";

  if (activeView === "limits") {
    startLimitPoll();
  } else {
    stopLimitPoll();
  }

  if (activeView === "room") {
    startRoomPoll();
  } else {
    stopRoomPoll();
  }

  if (activeView === "dashboard") {
    startUsagePoll();
  } else {
    stopUsagePoll();
  }

  if (activeView === "kombai") {
    startKombaiPoll();
  } else {
    stopKombaiPoll();
  }

  if (activeView === "discussions") {
    startDiscussionsPoll();
  } else {
    stopDiscussionsPoll();
  }

  render();

  if (activeView === "pool") void refreshPoolStatus();
  if (activeView === "limits") void refreshLimitStatus();
  if (activeView === "dashboard") {
    void refreshUsageDashboard();
    void refreshAccountUsage();
  }
  if (activeView === "kombai") void refreshKombaiStatus();
  if (activeView === "discussions") void refreshDiscussions();
  if (activeView === "history" && !promptHistoryLoaded) void refreshPromptHistory();
  if (activeView === "room") void refreshRoom();
};

const refreshLimitStatus = async () => {
  if (activeView === "limits") {
    statusText = "Lecture des limites serveur";
  }
  try {
    limitStatus = await invoke<AccountLimitView[]>("account_limit_status");
    limitStatusLoaded = true;
    statusText = "Limites serveur actualisees";
  } catch (error) {
    statusText = String(error);
    limitStatusLoaded = true;
  }

  if (activeView === "limits") {
    render();
  }
};

const startLimitPoll = () => {
  stopLimitPoll();
  limitPoll = window.setInterval(() => void refreshLimitStatus(), 300000);
};

const stopLimitPoll = () => {
  if (limitPoll !== null) {
    clearInterval(limitPoll);
    limitPoll = null;
  }
};

const refreshUsageDashboard = async () => {
  try {
    usageDashboard = await invoke<UsageDashboard>("usage_dashboard");
    usageLoaded = true;
  } catch (error) {
    statusText = String(error);
    usageLoaded = true;
  }

  if (activeView === "dashboard") {
    render();
  }
};

// Le scan des rollouts est coûteux (I/O disque, gros fichiers) : on ne le lance
// pas dans le poll 5s du dashboard, seulement à l'ouverture de la vue et sur
// action manuelle « Actualiser ».
const refreshAccountUsage = async () => {
  try {
    accountUsage = await invoke<AccountUsageDashboard>("account_token_usage");
    accountUsageLoaded = true;
  } catch (error) {
    statusText = String(error);
    accountUsageLoaded = true;
  }

  if (activeView === "dashboard") {
    render();
  }
};

const startUsagePoll = () => {
  stopUsagePoll();
  usagePoll = window.setInterval(() => void refreshUsageDashboard(), 5000);
};

const stopUsagePoll = () => {
  if (usagePoll !== null) {
    clearInterval(usagePoll);
    usagePoll = null;
  }
};

const kombaiStatusSummary = (status: KombaiStatus) =>
  status.running ? "Kombai actif" : status.started ? "Kombai en cours de demarrage" : "Kombai arrete";

const refreshKombaiStatus = async () => {
  try {
    const wasRunning = kombaiStatus?.running ?? false;
    kombaiStatus = await invoke<KombaiStatus>("kombai_status");
    kombaiLoaded = true;
    const recoveredFromError = kombaiStatusError;
    const runningChanged = kombaiStatus.running !== wasRunning;
    kombaiStatusError = false;
    if (activeView === "kombai") {
      if (recoveredFromError || runningChanged) {
        statusText = kombaiStatusSummary(kombaiStatus);
      }
      // Evite de recharger l'iframe a chaque tick : on ne re-render que si
      // l'etat "running" change (ou tant qu'on n'est pas encore lance).
      if (recoveredFromError || !kombaiStatus.running || runningChanged || !document.querySelector("#kombaiFrame")) {
        render();
      }
    }
  } catch (error) {
    kombaiStatusError = true;
    statusText = String(error);
    kombaiLoaded = true;
    if (activeView === "kombai") render();
  }
};

const startKombaiPoll = () => {
  stopKombaiPoll();
  kombaiPoll = window.setInterval(() => void refreshKombaiStatus(), 2000);
};

const stopKombaiPoll = () => {
  if (kombaiPoll !== null) {
    clearInterval(kombaiPoll);
    kombaiPoll = null;
  }
};

const refreshDiscussions = async () => {
  try {
    discussions = await invoke<DiscussionsView>("list_discussions");
    discussionsLoaded = true;
  } catch (error) {
    statusText = String(error);
    discussionsLoaded = true;
  }

  if (activeView === "discussions") {
    const host = document.querySelector<HTMLDivElement>("#discussionGroups");
    if (host) {
      refreshDiscussionList();
    } else {
      render();
    }
  }
};

const startDiscussionsPoll = () => {
  stopDiscussionsPoll();
  // Scan disque couteux : rafraichissement lent ; l'essentiel se fait a
  // l'ouverture de la vue et apres chaque action (reprise / archivage).
  discussionsPoll = window.setInterval(() => void refreshDiscussions(), 60000);
};

const stopDiscussionsPoll = () => {
  if (discussionsPoll !== null) {
    clearInterval(discussionsPoll);
    discussionsPoll = null;
  }
};

const allDiscussions = (): DiscussionSummary[] =>
  discussions?.accounts.flatMap((group) => group.discussions) ?? [];

const findDiscussion = (id: string | null | undefined) =>
  (id && allDiscussions().find((discussion) => discussion.sessionId === id)) || null;

const discussionMatches = (discussion: DiscussionSummary, label: string) => {
  const query = discussionSearch.trim().toLowerCase();
  if (!query) return true;
  return [discussion.title ?? "", discussion.preview ?? "", discussion.cwd ?? "", discussion.sessionId, label]
    .some((field) => field.toLowerCase().includes(query));
};

const resumeSessionInTerminal = async (accountId: string, sessionId: string) => {
  if (!settings || !settings.accounts.some((account) => account.id === accountId)) {
    statusText = "Compte introuvable pour cette discussion";
    render();
    return;
  }
  if (!isPlausibleSessionId(sessionId)) {
    statusText = "Identifiant de session invalide";
    render();
    return;
  }
  activeView = "terminal";
  stopLimitPoll();
  stopUsagePoll();
  stopKombaiPoll();
  stopDiscussionsPoll();
  await createNewTerminal(
    accountId,
    true,
    buildResumeCommand(sessionId, accountById(accountId)),
    codexAgentId(),
    sessionId,
  );
};

// Reprise dans le compte D'ORIGINE : on relance le fichier rollout HEAD (le
// plus recent de la chaine) via son `rolloutId`, non ambigu.
const resumeDiscussion = (discussion: DiscussionSummary) =>
  resumeSessionInTerminal(discussion.accountId, discussion.rolloutId || discussion.sessionId);

// Reprise dans un AUTRE compte : on copie le rollout HEAD vers le compte cible
// (nouvel uuid) puis on le reprend la-bas. La source reste intacte.
const continueDiscussionWith = async (discussion: DiscussionSummary, targetAccountId: string) => {
  if (!settings || !targetAccountId || targetAccountId === discussion.accountId) return;
  if (!settings.accounts.some((account) => account.id === targetAccountId)) return;
  discussionBusyId = discussion.sessionId;
  render();
  try {
    const copied = await invoke<DiscussionSummary>("copy_discussion_to_account", {
      sessionId: discussion.rolloutId || discussion.sessionId,
      sourceAccountId: discussion.accountId,
      targetAccountId,
    });
    discussionBusyId = null;
    const resumeId = copied.rolloutId || copied.sessionId;
    if (!isPlausibleSessionId(resumeId)) {
      statusText = "Copie effectuee mais identifiant invalide";
      await refreshDiscussions();
      return;
    }
    activeView = "terminal";
    stopLimitPoll();
    stopUsagePoll();
    stopKombaiPoll();
    stopDiscussionsPoll();
    await createNewTerminal(
      targetAccountId,
      true,
      buildResumeCommand(resumeId, accountById(targetAccountId)),
      codexAgentId(),
      resumeId,
    );
    void refreshDiscussions();
  } catch (error) {
    discussionBusyId = null;
    statusText = String(error);
    render();
  }
};

const deleteDiscussion = async (discussion: DiscussionSummary) => {
  const forkNote =
    discussion.forkCount > 1
      ? `\n\n${discussion.forkCount} fichiers (reprises incluses) seront archives.`
      : "";
  const confirmed = window.confirm(
    `Retirer cette discussion de l'historique ?\n\n${discussion.title || discussion.sessionId}${forkNote}\n\nLes fichiers sont deplaces dans sessions-archive (recuperables), pas supprimes definitivement.`,
  );
  if (!confirmed) return;
  discussionBusyId = discussion.sessionId;
  render();
  try {
    const result = await invoke<{ count?: number }>("delete_discussion", {
      accountId: discussion.accountId,
      sessionId: discussion.sessionId,
      archive: true,
    });
    discussionTargetSel.delete(discussion.sessionId);
    const count = result?.count ?? 1;
    statusText = count > 1 ? `Discussion archivee (${count} fichiers)` : "Discussion archivee";
  } catch (error) {
    statusText = String(error);
  }
  discussionBusyId = null;
  await refreshDiscussions();
};

// Compte cible retenu pour une discussion (defaut = compte d'origine, borne
// aux comptes existants pour rester valide meme si la liste a change).
const discussionTargetFor = (discussion: DiscussionSummary): string => {
  const stored = discussionTargetSel.get(discussion.sessionId);
  if (stored && settings?.accounts.some((account) => account.id === stored)) return stored;
  return discussion.accountId;
};

// Le backend conserve le premier message complet dans `preview` pour que la
// recherche porte sur davantage que le titre. Pour l'affichage, on retire le
// titre (qui est un prefixe exact de ce message) afin de ne pas presenter deux
// fois le meme texte dans la carte.
const discussionSubtitle = (discussion: DiscussionSummary): string => {
  const preview = discussion.preview?.trim() ?? "";
  const title = discussion.title?.trim() ?? "";
  if (!preview || !title || !preview.startsWith(title)) return preview;
  return preview
    .slice(title.length)
    .replace(/^[\s:;,.!?\u2014\u2013-]+/, "")
    .trim();
};

const renderDiscussionRow = (discussion: DiscussionSummary, accountLabel: string) => {
  const busy = discussionBusyId === discussion.sessionId;
  const accounts = settings?.accounts ?? [];
  const target = discussionTargetFor(discussion);
  const willCopy = target !== discussion.accountId;
  const title = discussion.title?.trim() || "(sans titre)";
  const subtitle = discussionSubtitle(discussion);
  const meta = [
    discussion.cwd
      ? `<span title="${escapeAttr(discussion.cwd)}"><i data-lucide="folder-open"></i>${escapeHtml(displayProjectDir(discussion.cwd))}</span>`
      : "",
    `<span><i data-lucide="clock-3"></i>${escapeHtml(formatTimestamp(discussion.lastActivity))}</span>`,
    discussion.totalTokens
      ? `<span><i data-lucide="bar-chart-3"></i>${escapeHtml(formatTokens(discussion.totalTokens))} tok</span>`
      : "",
    `<span>${discussion.messageCount} msg</span>`,
    discussion.forkCount > 1
      ? `<span title="Reprises regroupees (${discussion.forkCount} fichiers)"><i data-lucide="history"></i>${discussion.forkCount - 1} reprise${discussion.forkCount - 1 > 1 ? "s" : ""}</span>`
      : "",
  ]
    .filter(Boolean)
    .join("");

  // Le compte d'origine est propose EN PREMIER (marque), puis les autres. On
  // choisit le compte dans lequel reprendre directement ; s'il differe du
  // compte d'origine la reprise copie d'abord la discussion (non destructif).
  const options = accounts
    .map((account) => {
      const selected = account.id === target ? " selected" : "";
      const suffix = account.id === discussion.accountId ? " (origine)" : "";
      return `<option value="${escapeAttr(account.id)}"${selected}>${escapeHtml(account.label)}${suffix}</option>`;
    })
    .join("") ||
    `<option value="${escapeAttr(discussion.accountId)}" selected>${escapeHtml(accountLabel)}</option>`;

  return `
    <div class="discussion-row ${busy ? "busy" : ""}">
      <div class="discussion-main">
        <strong class="discussion-title" title="${escapeAttr(title)}">${escapeHtml(title)}</strong>
        ${subtitle ? `<span class="discussion-preview">${escapeHtml(subtitle)}</span>` : ""}
        <span class="discussion-meta">${meta}</span>
      </div>
      <div class="discussion-actions">
        <label class="discussion-account" title="Choisir le compte dans lequel reprendre cette discussion">
          <i data-lucide="users"></i>
          <select class="discussion-target" data-target-for="${escapeAttr(discussion.sessionId)}">
            ${options}
          </select>
        </label>
        <button class="tool-button primary" data-resume-session="${escapeAttr(discussion.sessionId)}" title="${willCopy ? "Copier la discussion dans le compte choisi puis la reprendre" : "Reprendre dans un terminal"}">
          <i data-lucide="${willCopy ? "copy" : "play"}"></i><span data-resume-label>${willCopy ? "Copier + reprendre" : "Reprendre"}</span>
        </button>
        <button class="icon-button wide danger" data-delete-session="${escapeAttr(discussion.sessionId)}" title="Retirer de l'historique (archive toutes les reprises)">
          <i data-lucide="trash-2"></i>
        </button>
      </div>
    </div>
  `;
};

const renderDiscussionGroups = () => {
  if (!discussionsLoaded) {
    return `<div class="pool-empty">Lecture des discussions Codex…</div>`;
  }
  const groups = discussions?.accounts ?? [];
  if (groups.length === 0) {
    return `<div class="pool-empty">Aucune discussion trouvee</div>`;
  }

  const blocks = groups
    .map((group) => {
      const rows = group.discussions.filter((discussion) => discussionMatches(discussion, group.label));
      if (rows.length === 0) return "";
      return `
        <section class="discussion-group">
          <header class="discussion-group-head">
            <strong>${escapeHtml(group.label)}</strong>
            <span>${rows.length}/${group.discussionCount} discussion(s)${group.hasTokens ? "" : " · deconnecte"}</span>
          </header>
          ${group.error ? `<div class="limit-error">${escapeHtml(group.error)}</div>` : ""}
          <div class="discussion-list">${rows.map((discussion) => renderDiscussionRow(discussion, group.label)).join("")}</div>
        </section>
      `;
    })
    .filter(Boolean)
    .join("");

  return blocks || `<div class="pool-empty">Aucune discussion ne correspond a « ${escapeHtml(discussionSearch)} »</div>`;
};

const renderDiscussionsPanel = () => {
  const groups = discussions?.accounts ?? [];
  const total = groups.reduce((sum, group) => sum + group.discussionCount, 0);
  const connected = groups.filter((group) => group.hasTokens).length;
  return `
    <section class="discussions-panel">
      <div class="discussions-head">
        <div>
          <strong>Discussions</strong>
          <span>${total} discussion(s) · ${connected}/${settings?.accounts.length ?? 0} compte(s)</span>
        </div>
        <div class="discussions-tools">
          <label class="discussion-search">
            <i data-lucide="search"></i>
            <input id="discussionSearch" type="search" placeholder="Rechercher (titre, dossier, id)" value="${escapeAttr(discussionSearch)}" />
          </label>
          <button id="refreshDiscussions" class="tool-button" title="Actualiser">
            <i data-lucide="refresh-ccw"></i><span>Actualiser</span>
          </button>
        </div>
      </div>
      <div class="discussion-groups" id="discussionGroups">${renderDiscussionGroups()}</div>
    </section>
  `;
};

const refreshDiscussionList = () => {
  const host = document.querySelector<HTMLDivElement>("#discussionGroups");
  if (!host) {
    render();
    return;
  }
  host.innerHTML = renderDiscussionGroups();
  createIcons({ icons: lucideIcons });
  bindDiscussionRowUi();
};

const bindDiscussionRowUi = () => {
  // Changement de compte cible : on memorise le choix et on met a jour, sans
  // re-render complet, le libelle/icone du bouton (Reprendre <-> Copier +
  // reprendre) pour ne pas voler le focus du select.
  document.querySelectorAll<HTMLSelectElement>(".discussion-target[data-target-for]").forEach((select) => {
    select.addEventListener("change", () => {
      const id = select.dataset.targetFor ?? "";
      const discussion = findDiscussion(id);
      if (!discussion) return;
      discussionTargetSel.set(id, select.value);
      const willCopy = select.value !== discussion.accountId;
      const row = select.closest(".discussion-row");
      const button = row?.querySelector<HTMLButtonElement>("[data-resume-session]");
      const label = button?.querySelector<HTMLElement>("[data-resume-label]");
      // On met a jour le libelle/title en place (l'icone se resynchronise au
      // prochain rendu complet). Pas de createIcons ici : lucide a deja remplace
      // le <i data-lucide> par un <svg> au premier rendu.
      if (label) label.textContent = willCopy ? "Copier + reprendre" : "Reprendre";
      if (button) {
        button.title = willCopy
          ? "Copier la discussion dans le compte choisi puis la reprendre"
          : "Reprendre dans un terminal";
      }
    });
  });
  document.querySelectorAll<HTMLButtonElement>("[data-resume-session]").forEach((button) => {
    button.addEventListener("click", () => {
      const discussion = findDiscussion(button.dataset.resumeSession);
      if (!discussion) return;
      const target = discussionTargetFor(discussion);
      if (target && target !== discussion.accountId) {
        void continueDiscussionWith(discussion, target);
      } else {
        void resumeDiscussion(discussion);
      }
    });
  });
  document.querySelectorAll<HTMLButtonElement>("[data-delete-session]").forEach((button) => {
    button.addEventListener("click", () => {
      const discussion = findDiscussion(button.dataset.deleteSession);
      if (discussion) void deleteDiscussion(discussion);
    });
  });
};

// --- Historique des demandes (recherche globale) -------------------------
// Index recherchable de TOUTES les demandes (messages utilisateur) envoyees a
// Codex, tous comptes et toutes sessions confondus. Le backend
// (`list_prompt_history`) scanne les rollouts ; le filtrage/recherche se fait
// cote client, comme pour la liste des discussions.
const PROMPT_RENDER_LIMIT = 400;

const refreshPromptHistory = async () => {
  try {
    promptHistory = await invoke<PromptHistoryView>("list_prompt_history", { limit: 4000 });
    promptHistoryLoaded = true;
  } catch (error) {
    statusText = String(error);
    promptHistoryLoaded = true;
  }

  // Rerender complet quand on est sur la vue : reconstruit aussi l'en-tete
  // (compteur « X demande(s) » + note de troncature), pas seulement la liste.
  if (activeView === "history") render();
};

const allPrompts = (): PromptEntry[] => promptHistory?.prompts ?? [];

const promptMatches = (entry: PromptEntry) => {
  const query = promptSearch.trim().toLowerCase();
  if (!query) return true;
  return [entry.text, entry.cwd ?? "", entry.accountLabel, entry.sessionTitle ?? "", entry.sessionId].some(
    (field) => field.toLowerCase().includes(query),
  );
};

const escapeRegExp = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// Surligne les occurrences de la requete en matchant sur le texte BRUT (les
// bornes <mark> tombent donc toujours sur des frontieres de caracteres reels,
// jamais au milieu d'une entite HTML ni decalees par toLowerCase), puis echappe
// CHAQUE tranche emise : aucune injection possible et le rendu reste exact.
const highlightMatch = (text: string, query: string) => {
  const needle = query.trim();
  if (!needle) return escapeHtml(text);
  const re = new RegExp(escapeRegExp(needle), "gi");
  let result = "";
  let last = 0;
  for (const match of text.matchAll(re)) {
    const start = match.index ?? 0;
    if (match[0].length === 0) break;
    result += escapeHtml(text.slice(last, start));
    result += `<mark>${escapeHtml(match[0])}</mark>`;
    last = start + match[0].length;
  }
  result += escapeHtml(text.slice(last));
  return result;
};

const renderPromptRow = (entry: PromptEntry) => {
  const meta = [
    `<span><i data-lucide="clock-3"></i>${escapeHtml(formatTimestamp(entry.timestamp))}</span>`,
    `<span><i data-lucide="users"></i>${escapeHtml(entry.accountLabel)}</span>`,
    entry.cwd
      ? `<span title="${escapeAttr(entry.cwd)}"><i data-lucide="folder-open"></i>${escapeHtml(displayProjectDir(entry.cwd))}</span>`
      : "",
  ]
    .filter(Boolean)
    .join("");
  const canResume = isPlausibleSessionId(entry.sessionId);
  return `
    <div class="prompt-row">
      <div class="prompt-main">
        <span class="prompt-text">${highlightMatch(entry.text, promptSearch)}</span>
        <span class="prompt-meta">${meta}</span>
      </div>
      <div class="prompt-actions">
        <button class="tool-button" data-prompt-resume="${escapeAttr(entry.sessionId)}" data-prompt-account="${escapeAttr(entry.accountId)}" title="Reprendre cette session dans un terminal" ${canResume ? "" : "disabled"}>
          <i data-lucide="play"></i><span>Reprendre</span>
        </button>
        <button class="icon-button wide" data-prompt-discussion="${escapeAttr(entry.sessionId)}" title="Voir dans les discussions">
          <i data-lucide="messages-square"></i>
        </button>
      </div>
    </div>
  `;
};

const renderPromptRows = () => {
  if (!promptHistoryLoaded) {
    return `<div class="pool-empty">Lecture des demandes Codex…</div>`;
  }
  const all = allPrompts();
  if (all.length === 0) {
    return `<div class="pool-empty">Aucune demande trouvee</div>`;
  }
  const matches = all.filter(promptMatches);
  if (matches.length === 0) {
    return `<div class="pool-empty">Aucune demande ne correspond a « ${escapeHtml(promptSearch)} »</div>`;
  }
  const shown = matches.slice(0, PROMPT_RENDER_LIMIT);
  const capped =
    matches.length > shown.length
      ? `<div class="prompt-more">Affichage limite a ${PROMPT_RENDER_LIMIT} sur ${matches.length} resultats — affine la recherche.</div>`
      : "";
  return `${shown.map(renderPromptRow).join("")}${capped}`;
};

const renderPromptHistoryPanel = () => {
  const total = promptHistory?.totalPrompts ?? 0;
  const returned = promptHistory?.returned ?? 0;
  const truncatedNote = promptHistory?.truncated ? ` · ${returned} plus recentes indexees` : "";
  const countLabel = promptHistoryLoaded ? `${total} demande(s)${truncatedNote}` : "Lecture…";
  return `
    <section class="discussions-panel">
      <div class="discussions-head">
        <div>
          <strong>Historique des demandes</strong>
          <span>${escapeHtml(countLabel)}</span>
        </div>
        <div class="discussions-tools">
          <label class="discussion-search">
            <i data-lucide="search"></i>
            <input id="promptSearch" type="search" placeholder="Rechercher dans vos demandes (texte, dossier, compte)" value="${escapeAttr(promptSearch)}" />
          </label>
          <button id="refreshPromptHistory" class="tool-button" title="Actualiser">
            <i data-lucide="refresh-ccw"></i><span>Actualiser</span>
          </button>
        </div>
      </div>
      <div class="discussion-groups" id="promptList">${renderPromptRows()}</div>
    </section>
  `;
};

const refreshPromptList = () => {
  const host = document.querySelector<HTMLDivElement>("#promptList");
  if (!host) {
    render();
    return;
  }
  host.innerHTML = renderPromptRows();
  createIcons({ icons: lucideIcons });
  bindPromptRowUi();
};

const openDiscussionForSession = (sessionId: string) => {
  discussionSearch = sessionId;
  if (activeView === "discussions") {
    refreshDiscussionList();
  } else {
    setActiveView("discussions");
  }
};

const bindPromptRowUi = () => {
  document.querySelectorAll<HTMLButtonElement>("[data-prompt-resume]").forEach((button) => {
    button.addEventListener("click", () => {
      const sessionId = button.dataset.promptResume;
      const accountId = button.dataset.promptAccount;
      if (sessionId && accountId) void resumeSessionInTerminal(accountId, sessionId);
    });
  });
  document.querySelectorAll<HTMLButtonElement>("[data-prompt-discussion]").forEach((button) => {
    button.addEventListener("click", () => {
      const sessionId = button.dataset.promptDiscussion;
      if (sessionId) openDiscussionForSession(sessionId);
    });
  });
};

const restoreTerminals = async () => {
  if (!settings) return;
  const state = loadOpenTerminalRecords();
  const records = state.terminals.filter((record) =>
    settings!.accounts.some((account) => account.id === record.accountId),
  );
  if (records.length === 0) return;

  const restored: TerminalSession[] = [];
  for (const record of records) {
    const account = settings.accounts.find((candidate) => candidate.id === record.accountId);
    if (!account) continue;
    const agentId =
      record.agentId && settings.agents.some((agent) => agent.id === record.agentId)
        ? record.agentId
        : codexAgentId();
    const session = createTerminalSession(account, proxyForAccount(account), agentId);
    session.key = record.key;
    session.codexSessionId = record.codexSessionId ?? null;
    session.resumeSessionId = record.codexSessionId ?? null;
    if (session.codexSessionId) claimedSessionIds.add(session.codexSessionId);
    terminalSessions.push(session);
    restored.push(session);
  }

  if (restored.length === 0) return;

  activeTerminalKey =
    (state.activeKey && restored.some((session) => session.key === state.activeKey) && state.activeKey) ||
    restored[0].key;
  activeView = "terminal";
  render();

  for (const session of restored) {
    const command = isPlausibleSessionId(session.codexSessionId)
      ? buildResumeCommand(session.codexSessionId, accountById(session.accountId))
      : null;
    await startTerminalSession(session, command);
  }

  persistTerminalSessions();
};

const startKombai = async () => {
  kombaiStatusError = false;
  statusText = "Demarrage de Kombai (VS Code embarque)...";
  render();
  try {
    kombaiStatus = await invoke<KombaiStatus>("kombai_start", { projectDir: currentProjectDir() });
    kombaiLoaded = true;
    statusText = kombaiStatus.message ?? "Kombai en cours de demarrage";
  } catch (error) {
    kombaiStatusError = true;
    statusText = String(error);
  }
  render();
  startKombaiPoll();
};

const stopKombai = async () => {
  try {
    kombaiStatus = await invoke<KombaiStatus>("kombai_stop");
    kombaiStatusError = false;
    statusText = "Kombai arrete";
  } catch (error) {
    kombaiStatusError = true;
    statusText = String(error);
  }
  render();
};

const installKombaiExtension = async () => {
  kombaiStatusError = false;
  statusText = "Installation de l'extension Kombai...";
  render();
  try {
    kombaiStatus = await invoke<KombaiStatus>("kombai_install_extension");
    kombaiLoaded = true;
    statusText = kombaiStatus.message ?? "Extension Kombai installee";
  } catch (error) {
    kombaiStatusError = true;
    statusText = String(error);
  }
  render();
};

const reloadKombaiFrame = () => {
  const frame = document.querySelector<HTMLIFrameElement>("#kombaiFrame");
  if (frame) frame.src = frame.src;
};

const testPool = async () => {
  if (!settings) return;
  if (!poolStatus?.running) {
    statusText = "Demarre le pool avant de lancer le test";
    render();
    return;
  }

  const session = activeTerminal();
  if (!session?.running || session.ptyId === null) {
    const accountId = selectedAccountId ?? settings.accounts[0]?.id ?? null;
    if (!accountId) {
      statusText = "Ajoute un compte avant de tester le pool";
      render();
      return;
    }

    statusText = "Ouverture d'un terminal de test";
    render();
    await createNewTerminal(accountId, true, null, codexAgentId());
  }

  const base = poolStatus?.baseUrl ?? `http://localhost:${settings?.pool.port ?? 8787}`;
  const model = settings?.pool.defaultModel ?? "gpt-5-codex";
  const key = settings?.pool.apiKey ? `-H "Authorization: Bearer ${settings.pool.apiKey}" ` : "";
  const cmd = `curl -N ${base}/v1/chat/completions ${key}-H "Content-Type: application/json" -d "{\\"model\\":\\"${model}\\",\\"stream\\":true,\\"messages\\":[{\\"role\\":\\"user\\",\\"content\\":\\"ping\\"}]}"`;
  const sent = await sendLine(cmd);
  if (!sent) {
    statusText = "Aucun terminal actif pour lancer le test";
    render();
  }
};

const parseImportPaths = (value: string) =>
  value
    .split(/[\n;,]+/)
    .map((item) => item.trim().replace(/^"|"$/g, ""))
    .filter(Boolean);

const isJsonObjectText = (value: string) => {
  const trimmed = value.trim();
  return trimmed.startsWith("{") || trimmed.startsWith("[");
};

const normalizeImportJsonText = (value: string) => {
  const trimmed = value.trim();
  if (isJsonObjectText(trimmed)) return trimmed;

  try {
    const parsed = JSON.parse(trimmed);
    if (typeof parsed === "string" && isJsonObjectText(parsed)) return parsed.trim();
  } catch {
    // Rust will produce the detailed JSON error for malformed pasted content.
  }

  if (
    trimmed.startsWith('"{') ||
    trimmed.startsWith('"[') ||
    trimmed.startsWith('"{\\"') ||
    trimmed.startsWith('"[\\"') ||
    trimmed.startsWith('{\\"') ||
    trimmed.startsWith('[\\"')
  ) {
    return trimmed;
  }

  return null;
};

const finishPoolImport = async (message: string) => {
  selectedAccountId = settings?.defaultAccountId || settings?.accounts[0]?.id || null;
  await refreshPoolAfterAccountChange(message);
};

const importPoolFiles = async () => {
  if (!settings) return;
  readPoolForm();

  if (poolImportPaths.trim().length === 0) {
    statusText = "Colle un blob de session ou un chemin JSON";
    render();
    return;
  }

  try {
    settings = await invoke<AppSettings>("save_settings", { settings });

    const jsonContent = normalizeImportJsonText(poolImportPaths);
    if (jsonContent !== null) {
      settings = await invoke<AppSettings>("import_account_json", { content: jsonContent });
      await finishPoolImport("Compte importe depuis le JSON colle");
      return;
    }

    const paths = parseImportPaths(poolImportPaths);
    if (paths.length === 0) {
      statusText = "Ajoute au moins un chemin JSON";
      render();
      return;
    }

    settings = await invoke<AppSettings>("import_account_docs", { paths });
    await finishPoolImport(`${paths.length} source(s) importee(s) dans le pool`);
  } catch (error) {
    statusText = String(error);
  }

  render();
};

const pickProjectDir = async () => {
  if (!settings) return;

  readSettingsForm();
  const currentDir = selectedAccount()?.projectDir ?? "";

  try {
    const picked = await invoke<string | null>("pick_project_dir", { currentDir });
    if (!picked) {
      statusText = "Selection annulee";
      render();
      return;
    }

    const account = selectedAccount();
    if (!account) return;

    account.projectDir = picked;
    syncSessionsForAccount(account);
    settings.defaultAccountId = selectedAccountId;
    settings = await invoke<AppSettings>("save_settings", { settings });
    statusText = "Dossier projet associe";
  } catch (error) {
    statusText = String(error);
  }

  render();
};

// --- Selecteur de workspace ----------------------------------------------
// Ouvre le choix du dossier de travail global. Desktop : dialogue natif.
// Web : modale de navigation des dossiers du serveur (borne a la racine).
const openWorkspacePicker = async () => {
  if (isRemoteMode()) {
    workspaceModalOpen = true;
    workspaceBrowse = null;
    workspaceBrowseError = "";
    render();
    await loadWorkspaceDir(currentWorkspace());
    return;
  }

  try {
    const picked = await invoke<string | null>("pick_project_dir", {
      currentDir: currentWorkspace() ?? "",
    });
    if (picked) {
      setCurrentWorkspace(picked);
      statusText = `Workspace: ${picked}`;
    } else {
      statusText = "Selection annulee";
    }
  } catch (error) {
    statusText = String(error);
  }
  render();
};

const loadWorkspaceDir = async (path: string | null) => {
  workspaceBrowseLoading = true;
  workspaceBrowseError = "";
  render();
  try {
    workspaceBrowse = await invoke<FsListResponse>("list_dir", {
      path: path ?? undefined,
    });
  } catch (error) {
    workspaceBrowseError = String(error);
    workspaceBrowse = null;
  }
  workspaceBrowseLoading = false;
  render();
};

const closeWorkspaceModal = () => {
  workspaceModalOpen = false;
  render();
};

const chooseWorkspace = (path: string | null) => {
  setCurrentWorkspace(path);
  workspaceModalOpen = false;
  statusText = path ? `Workspace: ${path}` : "Workspace retire";
  render();
};

const createPoolTerminal = async () => {
  try {
    const picked = await invoke<AccountProfile>("pool_pick_terminal_account");
    settings = await invoke<AppSettings>("load_settings");
    selectedAccountId = picked.id;
    activeView = "terminal";
    stopLimitPoll();
    stopUsagePoll();
    statusText = `Pool -> ${picked.label}`;
    render();
    await createNewTerminal(undefined, false, null, codexAgentId());
  } catch (error) {
    statusText = String(error);
    render();
  }
};

const formatPoolTokens = (account: PoolAccountView) => {
  if (!account.hasTokens) return "non";
  const base = account.hasRefreshToken ? "access + refresh" : "access seul";
  return `${base} (${account.oauthClient} client)`;
};

const renderPoolRow = (account: PoolAccountView) => {
  const pending = account.id === pendingDeleteAccountId;
  const actions = pending
    ? `<div class="pool-row-actions">
        <button class="icon-button danger" data-remove-account-confirm="${escapeAttr(account.id)}" title="Confirmer la suppression">
          <i data-lucide="check"></i>
        </button>
        <button class="icon-button" data-remove-account-cancel="${escapeAttr(account.id)}" title="Annuler">
          <i data-lucide="x"></i>
        </button>
      </div>`
    : `<button class="icon-button danger" data-remove-account="${escapeAttr(account.id)}" title="Retirer ce compte du pool (le dossier reste sur le disque)">
        <i data-lucide="trash-2"></i>
      </button>`;
  return `
  <tr>
    <td>${escapeHtml(account.label)}</td>
    <td><span class="pool-badge ${account.status}">${escapeHtml(account.status)}</span></td>
    <td>${escapeHtml(account.proxyMasked)}</td>
    <td>${escapeHtml(formatPoolTokens(account))}</td>
    <td>${account.served}</td>
    <td>${account.errors}</td>
    <td class="wrap">${escapeHtml(account.lastError ?? "")}</td>
    <td class="pool-row-actions-cell">${actions}</td>
  </tr>
`;
};

const terminalTitle = (session: TerminalSession) =>
  settings?.accounts.find((account) => account.id === session.accountId)?.label ?? session.title;

const syncSessionsForAccount = (account: AccountProfile) => {
  const proxy = proxyForAccount(account);
  const proxySummary = proxy ? maskProxy(proxy.proxyUrl) : "sans proxy";

  terminalSessions.forEach((session) => {
    if (session.accountId === account.id) {
      session.title = account.label;
      session.projectDir = account.projectDir?.trim() || null;
      session.proxySummary = proxySummary;
    }
  });
};

const render = () => {
  if (!settings) {
    app.innerHTML = `<main class="boot">Chargement</main>`;
    return;
  }

  terminalSessions.forEach((session) => {
    const element = session.terminal.element;
    element?.parentElement?.removeChild(element);
  });

  const account = selectedAccount();
  const proxiesEnabled = proxyControlsEnabled();
  const proxy = selectedProxy();
  const activeSession = activeTerminal();
  const activeRunning = activeSession?.running ?? false;
  const agent = activeAgent();
  const agentOptions = settings.agents
    .map(
      (item) =>
        `<option value="${escapeAttr(item.id)}" ${item.id === agent?.id ? "selected" : ""}>${escapeHtml(item.label)}</option>`,
    )
    .join("");
  const contextProxy = proxiesEnabled
    ? (activeSession?.proxySummary ?? (proxy ? maskProxy(proxy.proxyUrl) : "sans proxy"))
    : "proxy off";
  const contextProject = displayProjectDir(activeSession?.projectDir ?? account?.projectDir);
  const workspacePath = currentWorkspace();
  const workspaceChipLabel = workspacePath ? workspaceBaseName(workspacePath) : "Workspace";
  const workspaceTitle = workspacePath
    ? `Workspace des nouveaux agents: ${workspacePath}`
    : "Aucun workspace: les nouveaux agents demarrent dans le dossier par defaut";
  const terminalCountLabel =
    terminalSessions.length === 1 ? "1 terminal" : `${terminalSessions.length} terminaux`;
  const terminalSideItems = terminalSessions
    .map(
      (session) => `
        <div class="terminal-side-item ${session.key === activeTerminalKey ? "active" : ""}">
          <button class="terminal-side-button" data-terminal-key="${escapeAttr(session.key)}" title="${escapeAttr(terminalTitle(session))}">
            <i data-lucide="square-terminal"></i>
            <span class="terminal-side-main">
              <span class="terminal-side-title">${escapeHtml(terminalTitle(session))}</span>
              <span class="terminal-side-meta">${escapeHtml(`${session.ptyId ? `#${session.ptyId}` : session.status} | ${displayProjectDir(session.projectDir)}`)}</span>
            </span>
            <span class="live-dot ${session.running ? "on" : ""}"></span>
          </button>
          <button class="terminal-side-close" data-close-terminal="${escapeAttr(session.key)}" title="Fermer terminal">
            <i data-lucide="x"></i>
          </button>
        </div>
      `,
    )
    .join("");
  const sessionTabs = terminalSessions
    .map(
      (session) => `
        <div class="terminal-tab-item ${session.key === activeTerminalKey ? "active" : ""}">
          <button class="terminal-tab" data-terminal-key="${escapeAttr(session.key)}" title="${escapeAttr(terminalTitle(session))}">
            <i data-lucide="square-terminal"></i>
            <span>${escapeHtml(terminalTitle(session))}</span>
            <small>${session.ptyId ? `#${session.ptyId}` : escapeHtml(session.status)}</small>
          </button>
          <button class="tab-close" data-close-terminal="${escapeAttr(session.key)}" title="Fermer terminal">
            <i data-lucide="x"></i>
          </button>
        </div>
      `,
    )
    .join("");

  app.innerHTML = `
    <div class="layout">
      <aside class="sidebar">
        <header class="brand">
          <i data-lucide="square-terminal"></i>
          <div>
            <strong>Codex Terminal</strong>
            <span>${escapeHtml(terminalCountLabel)}</span>
          </div>
        </header>

        <section class="side-section">
          <div class="section-row">
            <span>Terminaux</span>
            <button class="icon-button" id="newTerminalSide" title="Nouveau terminal">
              <i data-lucide="plus"></i>
            </button>
          </div>
          <div class="terminal-side-list">${terminalSideItems || `<div class="empty">Aucun terminal ouvert</div>`}</div>
        </section>
      </aside>

      <main class="workspace">
        <header class="topbar">
          <div class="session-title">
            <span class="live-dot ${activeRunning ? "on" : ""}"></span>
            <div>
              <strong>${escapeHtml(activeSession ? terminalTitle(activeSession) : (account?.label ?? "Aucun terminal"))}</strong>
              <span>${escapeHtml(`${contextProxy} | ${contextProject}`)}</span>
            </div>
          </div>
          <div class="actions">
            <div class="workspace-control" title="${escapeAttr(workspaceTitle)}">
              <button id="workspacePick" class="tool-button ${workspacePath ? "primary" : ""}" title="${escapeAttr(workspaceTitle)}">
                <i data-lucide="folder-open"></i>
                <span>${escapeHtml(workspaceChipLabel)}</span>
              </button>
              ${workspacePath
                ? `<button id="workspaceClear" class="icon-button" title="Retirer le workspace">
                <i data-lucide="x"></i>
              </button>`
                : ""}
            </div>
            <button id="fullscreenToggle" class="icon-button wide ${isFullscreen ? "active" : ""}" title="${isFullscreen ? "Quitter plein ecran (F11)" : "Plein ecran (F11)"}" aria-label="${isFullscreen ? "Quitter plein ecran" : "Plein ecran"}" aria-pressed="${isFullscreen}">
              <i data-lucide="${isFullscreen ? "minimize-2" : "maximize-2"}"></i>
            </button>
            <button id="poolToggle" class="tool-button ${activeView === "pool" ? "primary" : ""}" title="Pool manager">
              <i data-lucide="server"></i>
              <span>Pool</span>
            </button>
            <button id="limitsToggle" class="tool-button ${activeView === "limits" ? "primary" : ""}" title="Resets limites">
              <i data-lucide="calendar-clock"></i>
              <span>Limites</span>
            </button>
            <button id="dashboardToggle" class="tool-button ${activeView === "dashboard" ? "primary" : ""}" title="Dashboard usage">
              <i data-lucide="bar-chart-3"></i>
              <span>Stats</span>
            </button>
            <button id="kombaiToggle" class="tool-button ${activeView === "kombai" ? "primary" : ""}" title="Kombai (VS Code embarque)">
              <i data-lucide="bot"></i>
              <span>Kombai</span>
            </button>
            <button id="discussionsToggle" class="tool-button ${activeView === "discussions" ? "primary" : ""}" title="Historique des discussions">
              <i data-lucide="messages-square"></i>
              <span>Discussions</span>
            </button>
            <button id="historyToggle" class="tool-button ${activeView === "history" ? "primary" : ""}" title="Historique des demandes (recherche)">
              <i data-lucide="history"></i>
              <span>Historique</span>
            </button>
            <button id="roomToggle" class="tool-button ${activeView === "room" ? "primary" : ""}" title="Salon d'agents (communication inter-agents)">
              <i data-lucide="users"></i>
              <span>Salon</span>
            </button>
            <button id="newTerminal" class="tool-button primary" title="Nouveau terminal">
              <i data-lucide="plus"></i>
              <span>Terminal</span>
            </button>
            <button id="poolTerminal" class="tool-button" title="Terminal depuis le pool">
              <i data-lucide="shuffle"></i>
              <span>Pool term</span>
            </button>
            <div class="agent-control" title="Agent a lancer dans le terminal actif">
              <select id="agentSelect" class="agent-select" title="Agent actif" aria-label="Agent actif" ${settings.agents.length ? "" : "disabled"}>
                ${agentOptions || `<option value="">Aucun agent</option>`}
              </select>
              <button id="runAgent" class="tool-button agent-run" title="${agent ? (agentIsIde(agent) ? `Ouvrir ${escapeAttr(agent.label)} dans ${escapeAttr(agent.command)}` : `Lancer ${escapeAttr(agent.label)}`) : "Lancer l'agent"}" ${agent && (agentIsIde(agent) || activeRunning) ? "" : "disabled"}>
                <i data-lucide="${agent && agentIsIde(agent) ? "bot" : "play"}"></i>
                <span>${escapeHtml(agent?.label ?? "Agent")}</span>
              </button>
            </div>
            <button id="manageAgents" class="icon-button wide" title="Gerer les agents">
              <i data-lucide="bot"></i>
            </button>
            ${agent?.statusCommand
              ? `<button id="loginStatus" class="icon-button wide" title="Statut login" ${activeRunning ? "" : "disabled"}>
              <i data-lucide="badge-check"></i>
            </button>`
              : ""}
            ${agent?.doctorCommand
              ? `<button id="doctor" class="icon-button wide" title="Doctor" ${activeRunning ? "" : "disabled"}>
              <i data-lucide="stethoscope"></i>
            </button>`
              : ""}
          </div>
        </header>

        <section class="terminal-shell">
          ${activeView === "pool"
            ? renderPoolPanel()
            : activeView === "limits"
              ? renderLimitsPanel()
              : activeView === "dashboard"
                ? renderDashboardPanel()
                : activeView === "kombai"
                  ? renderKombaiPanel()
                  : activeView === "discussions"
                    ? renderDiscussionsPanel()
                    : activeView === "history"
                      ? renderPromptHistoryPanel()
                      : activeView === "room"
                        ? renderRoomPanel()
                        : `<div id="terminal"></div>`}
        </section>

        <footer class="statusbar">
          <span>${escapeHtml(statusText)}</span>
          <span>${activeSession?.ptyId ? `PTY #${activeSession.ptyId}` : "PTY inactif"}</span>
        </footer>
      </main>
    </div>
    ${renderNewTerminalModal()}
    ${renderAgentsModal()}
    ${renderWorkspaceModal()}
  `;

  createIcons({ icons: lucideIcons });
  bindUi();
  mountActiveTerminal();
};

const renderAccountsPanel = (proxyOptions: string, proxiesEnabled: boolean) => {
  if (!settings) return "";

  const account = selectedAccount();
  const accounts = settings.accounts
    .map(
      (item) => `
        <button class="account ${item.id === selectedAccountId ? "active" : ""}" data-account="${item.id}">
          <span class="account-main">
            <span class="account-name">${escapeHtml(item.label)}</span>
            <span class="account-path">${escapeHtml(item.codexHome)}</span>
            <span class="account-project">${escapeHtml(displayProjectDir(item.projectDir))}</span>
          </span>
          <span class="proxy-dot ${proxiesEnabled && item.proxyId ? "bound" : ""}" title="Proxy"></span>
        </button>
      `,
    )
    .join("");
  const proxies = settings.proxies
    .map(
      (item) => `
        <div class="proxy-item">
          <span>${escapeHtml(item.label)}</span>
          <small>${escapeHtml(maskProxy(item.proxyUrl))}</small>
        </div>
      `,
    )
    .join("");

  return `
    <section class="accounts-panel">
      <div class="accounts-head">
        <div>
          <strong>Gestion des comptes</strong>
          <span>${settings.accounts.length} compte(s) | ${settings.proxies.length} proxy(s)</span>
        </div>
        <div class="account-actions">
          <button id="addAccount" class="tool-button">
            <i data-lucide="plus"></i>
            <span>Compte</span>
          </button>
          <button id="saveSettings" class="tool-button primary">
            <i data-lucide="save"></i>
            <span>Save</span>
          </button>
        </div>
      </div>

      <div class="accounts-layout">
        <section class="accounts-list-panel">
          <div class="section-row"><span>Comptes</span></div>
          <div class="account-list">${accounts || `<div class="empty">Aucun compte</div>`}</div>
        </section>

        <section class="account-editor">
          <div class="section-row">
            <span>Compte selectionne</span>
            <button id="removeAccount" class="icon-button wide danger" title="Supprimer le compte" ${account ? "" : "disabled"}>
              <i data-lucide="trash-2"></i>
            </button>
          </div>
          <div class="account-form-grid">
            <label>
              <span>Compte</span>
              <input id="accountLabel" value="${escapeAttr(account?.label ?? "")}" ${account ? "" : "disabled"} />
            </label>
            <label class="wide-field">
              <span>CODEX_HOME</span>
              <input id="accountHome" value="${escapeAttr(account?.codexHome ?? "")}" ${account ? "" : "disabled"} />
            </label>
            <label class="wide-field project-control">
              <span>${projectFieldLabel()}</span>
              <div class="field-row">
                <input id="projectDir" value="${escapeAttr(account?.projectDir ?? "")}" placeholder="${escapeAttr(projectFieldPlaceholder())}" ${account ? "" : "disabled"} />
                <button id="pickProjectDir" type="button" class="icon-button" title="Choisir dossier projet" ${account && !isRemoteMode() ? "" : "disabled"}>
                  <i data-lucide="folder-open"></i>
                </button>
              </div>
            </label>
            <label>
              <span>Proxy compte</span>
              <select id="proxySelect" ${account && proxiesEnabled ? "" : "disabled"}>${proxyOptions}</select>
            </label>
            <label class="toggle" title="Lance Codex en mode bypass (--dangerously-bypass-approvals-and-sandbox) pour CE compte">
              <input id="accountBypass" type="checkbox" ${(account?.bypass ?? settings.codexBypass ?? true) ? "checked" : ""} ${account ? "" : "disabled"} />
              <span>Bypass compte</span>
            </label>
          </div>
        </section>

        <section class="account-editor proxy-section ${proxiesEnabled ? "" : "disabled-section"}">
          <div class="section-row">
            <span>Proxy</span>
            <button class="icon-button" id="addProxy" title="${proxiesEnabled ? "Ajouter un proxy" : "Proxies desactives"}" ${proxiesEnabled ? "" : "disabled"}>
              <i data-lucide="plug-zap"></i>
            </button>
          </div>
          <div class="proxy-list">${proxies || `<div class="empty">Aucun proxy</div>`}</div>
        </section>

        <section class="account-editor global-settings">
          <div class="section-row"><span>Application</span></div>
          <div class="account-form-grid compact">
            <label>
              <span>Shell</span>
              <input id="shellInput" value="${escapeAttr(settings.shell)}" />
            </label>
            <label>
              <span>Commande</span>
              <input id="codexCommand" value="${escapeAttr(settings.codexCommand)}" />
            </label>
            <label class="toggle">
              <input id="autoRun" type="checkbox" ${settings.autoRunCodex ? "checked" : ""} />
              <span>Auto</span>
            </label>
            <label class="toggle" title="Bypass Codex par defaut pour les NOUVEAUX comptes (--dangerously-bypass-approvals-and-sandbox). Chaque compte peut ensuite l'activer/desactiver individuellement.">
              <input id="codexBypass" type="checkbox" ${settings.codexBypass ? "checked" : ""} />
              <span>Bypass defaut</span>
            </label>
            <label class="toggle" title="Re-scanne ~/.codex* et ajoute automatiquement les comptes trouves a chaque chargement">
              <input id="autoDiscover" type="checkbox" ${settings.autoDiscoverAccounts ? "checked" : ""} />
              <span>Auto-detect</span>
            </label>
            <label class="toggle" title="Activer ou desactiver toute la partie proxy">
              <input id="proxyControls" type="checkbox" ${proxiesEnabled ? "checked" : ""} />
              <span>Proxys</span>
            </label>
          </div>
        </section>
      </div>
    </section>
  `;
};

const renderNewTerminalModal = () => {
  if (!settings || !newTerminalModalOpen) return "";

  const account = newTerminalAccount();
  const selectedAgent = newTerminalAgent();
  const accountOptions = settings.accounts
    .map(
      (item) =>
        `<option value="${escapeAttr(item.id)}" ${item.id === account?.id ? "selected" : ""}>${escapeHtml(item.label)}</option>`,
    )
    .join("");
  const agentOptions = settings.agents
    .map(
      (item) =>
        `<option value="${escapeAttr(item.id)}" ${item.id === selectedAgent?.id ? "selected" : ""}>${escapeHtml(item.label)}</option>`,
    )
    .join("");
  const proxyOptions = [
    `<option value="">Aucun proxy</option>`,
    ...settings.proxies.map(
      (item) =>
        `<option value="${escapeAttr(item.id)}" ${item.id === account?.proxyId ? "selected" : ""}>${escapeHtml(item.label)}</option>`,
    ),
  ].join("");

  return `
    <div class="modal-backdrop" id="newTerminalBackdrop">
      <section class="modal" role="dialog" aria-modal="true" aria-labelledby="newTerminalTitle">
        <header class="modal-head">
          <div>
            <h2 id="newTerminalTitle">Nouveau terminal</h2>
            <p>Choisis l'agent et le compte a utiliser pour cette session.</p>
          </div>
          <button class="icon-button" id="closeNewTerminalModal" title="Fermer">
            <i data-lucide="x"></i>
          </button>
        </header>

        <div class="modal-body">
          <section class="modal-section">
            <label>
              <span>Agent</span>
              <select id="newTerminalAgent" ${settings.agents.length > 0 ? "" : "disabled"}>
                ${agentOptions || `<option value="">Aucun agent</option>`}
              </select>
            </label>
            <label>
              <span>Compte</span>
              <select id="newTerminalAccount" ${settings.accounts.length > 0 ? "" : "disabled"}>
                ${accountOptions || `<option value="">Aucun compte</option>`}
              </select>
            </label>
            <div class="modal-inline">
              <label>
                <span>Ajouter un compte</span>
                <input id="newTerminalAccountLabel" placeholder="perso, pro, client" />
              </label>
              <button class="tool-button" id="addAccountFromModal">
                <i data-lucide="plus"></i>
                <span>Ajouter</span>
              </button>
            </div>
          </section>

          <section class="modal-section">
            <label>
              <span>CODEX_HOME</span>
              <input id="newTerminalCodexHome" value="${escapeAttr(account?.codexHome ?? "")}" placeholder="%USERPROFILE%\\.codex-perso" ${account ? "" : "disabled"} />
            </label>
            <label>
              <span>${projectFieldLabel()}</span>
              <input id="newTerminalProjectDir" value="${escapeAttr(account?.projectDir ?? "")}" placeholder="${escapeAttr(projectFieldPlaceholder())}" ${account ? "" : "disabled"} />
            </label>
            <label>
              <span>Proxy</span>
              <select id="newTerminalProxy" ${account && settings.proxyControlsEnabled ? "" : "disabled"}>
                ${proxyOptions}
              </select>
            </label>
            <label class="modal-check">
              <input id="newTerminalAutoRun" type="checkbox" ${settings.autoRunCodex ? "checked" : ""} />
              <span>Lancer l'agent au demarrage${selectedAgent ? ` (${escapeHtml(selectedAgent.label)})` : ""}</span>
            </label>
          </section>
        </div>

        <footer class="modal-actions">
          <button class="tool-button" id="cancelNewTerminal">Annuler</button>
          ${selectedAgent?.loginCommand
            ? `<button class="tool-button" id="loginNewTerminal" ${account ? "" : "disabled"}>
            <i data-lucide="badge-check"></i>
            <span>Login ${escapeHtml(selectedAgent.label)}</span>
          </button>`
            : ""}
          <button class="tool-button primary" id="confirmNewTerminal" ${account ? "" : "disabled"}>
            <i data-lucide="square-terminal"></i>
            <span>Creer le terminal</span>
          </button>
        </footer>
      </section>
    </div>
  `;
};

const renderAgentsModal = () => {
  if (!settings || !agentsModalOpen) return "";

  const rows = settings.agents
    .map((item) => {
      const isIde = agentIsIde(item);
      return `
        <div class="agent-row">
          <div class="agent-row-head">
            <span class="agent-row-title">
              <i data-lucide="${isIde ? "app-window" : "bot"}"></i>
              ${escapeHtml(item.label || item.id)}
              ${item.builtin ? `<span class="agent-tag">integre</span>` : ""}
              ${isIde ? `<span class="agent-tag ide">IDE</span>` : ""}
            </span>
            <button class="icon-button danger" data-remove-agent="${escapeAttr(item.id)}" title="${item.builtin ? "Agent integre non supprimable" : "Supprimer l'agent"}" ${item.builtin ? "disabled" : ""}>
              <i data-lucide="trash-2"></i>
            </button>
          </div>
          <div class="agent-row-grid">
            <label>
              <span>Nom</span>
              <input data-agent-field="label" data-agent-id="${escapeAttr(item.id)}" value="${escapeAttr(item.label)}" ${item.builtin ? "disabled" : ""} />
            </label>
            <label>
              <span>Type</span>
              <select data-agent-field="kind" data-agent-id="${escapeAttr(item.id)}" ${item.builtin ? "disabled" : ""}>
                <option value="cli" ${isIde ? "" : "selected"}>CLI (terminal)</option>
                <option value="ide" ${isIde ? "selected" : ""}>IDE (editeur)</option>
              </select>
            </label>
            <label>
              <span>${isIde ? "Editeur" : "Commande"}</span>
              <input data-agent-field="command" data-agent-id="${escapeAttr(item.id)}" value="${escapeAttr(item.command)}" ${isIde ? `list="ideCommands"` : ""} placeholder="${isIde ? "code" : "codex"}" />
            </label>
          </div>
        </div>
      `;
    })
    .join("");

  return `
    <div class="modal-backdrop" id="agentsBackdrop">
      <section class="modal" role="dialog" aria-modal="true" aria-labelledby="agentsModalTitle">
        <header class="modal-head">
          <div>
            <h2 id="agentsModalTitle">Agents</h2>
            <p>Agents lancables dans un terminal (CLI, ex. Codex) ou dans un editeur (IDE, ex. Kombai).</p>
          </div>
          <button class="icon-button" id="closeAgentsModal" title="Fermer">
            <i data-lucide="x"></i>
          </button>
        </header>

        <datalist id="ideCommands">
          ${KNOWN_IDE_COMMANDS.map((cmd) => `<option value="${escapeAttr(cmd)}"></option>`).join("")}
        </datalist>

        <div class="modal-body">
          <section class="modal-section agent-manager-list">
            ${rows || `<div class="empty">Aucun agent</div>`}
          </section>
          <button class="tool-button" id="addAgent">
            <i data-lucide="plus"></i>
            <span>Ajouter un agent</span>
          </button>
          <p class="agent-hint">Kombai est une extension d'IDE : un agent <strong>IDE</strong> ouvre l'editeur choisi (code, cursor, windsurf, trae, antigravity, kiro) sur le dossier projet, ou tu utilises le panneau Kombai.</p>
        </div>

        <footer class="modal-actions">
          <button class="tool-button" id="cancelAgentsModal">Annuler</button>
          <button class="tool-button primary" id="saveAgentsModal">
            <i data-lucide="save"></i>
            <span>Enregistrer</span>
          </button>
        </footer>
      </section>
    </div>
  `;
};

const renderWorkspaceModal = () => {
  if (!workspaceModalOpen) return "";

  const data = workspaceBrowse;
  const entries = data?.entries ?? [];
  const list = entries
    .map(
      (entry) => `
        <button class="ws-entry" data-ws-dir="${escapeAttr(entry.path)}" title="${escapeAttr(entry.path)}">
          <i data-lucide="folder-open"></i>
          <span>${escapeHtml(entry.name)}</span>
        </button>`,
    )
    .join("");
  const selected = currentWorkspace();

  return `
    <div class="modal-backdrop" id="workspaceBackdrop">
      <section class="modal" role="dialog" aria-modal="true" aria-labelledby="workspaceModalTitle">
        <header class="modal-head">
          <div>
            <h2 id="workspaceModalTitle">Choisir un workspace</h2>
            <p>Dossier du serveur ou demarreront les prochains agents (cwd).</p>
          </div>
          <button class="icon-button" id="closeWorkspaceModal" title="Fermer">
            <i data-lucide="x"></i>
          </button>
        </header>

        <div class="modal-body">
          <div class="ws-path-row">
            <input id="workspacePathInput" value="${escapeAttr(data?.path ?? "")}" placeholder="/chemin/vers/dossier" spellcheck="false" />
            <button class="tool-button" id="workspaceGo" title="Aller a ce chemin">
              <i data-lucide="search"></i>
              <span>Aller</span>
            </button>
          </div>
          ${selected ? `<div class="ws-current">Workspace actuel : <strong>${escapeHtml(selected)}</strong></div>` : ""}
          ${data?.parent
            ? `<button class="ws-entry ws-parent" data-ws-dir="${escapeAttr(data.parent)}" title="${escapeAttr(data.parent)}">
                 <i data-lucide="folder-open"></i>
                 <span>.. (dossier parent)</span>
               </button>`
            : ""}
          ${workspaceBrowseLoading ? `<div class="ws-hint">Chargement...</div>` : ""}
          ${workspaceBrowseError ? `<div class="ws-error">${escapeHtml(workspaceBrowseError)}</div>` : ""}
          <div class="ws-list">${list || (workspaceBrowseLoading ? "" : `<div class="empty">Aucun sous-dossier</div>`)}</div>
        </div>

        <footer class="modal-actions">
          <button class="tool-button" id="cancelWorkspaceModal">Annuler</button>
          <button class="tool-button" id="clearWorkspaceModal">Aucun workspace</button>
          <button class="tool-button primary" id="confirmWorkspaceModal" ${data?.path ? "" : "disabled"}>
            <i data-lucide="badge-check"></i>
            <span>Choisir ce dossier</span>
          </button>
        </footer>
      </section>
    </div>
  `;
};

const renderKombaiPanel = () => {
  const status = kombaiStatus;
  const projectDir = currentProjectDir();
  const running = status?.running ?? false;
  const started = status?.started ?? false;
  const binaryAvailable = status?.binaryAvailable ?? true;
  const port = status?.port ?? settings?.kombai?.port ?? 8899;
  const command = status?.command ?? settings?.kombai?.codeServerCommand ?? "code-server";
  const extensionId = status?.extensionId ?? settings?.kombai?.extensionId ?? "kombai.kombai";

  if (running && status?.url) {
    const src = projectDir
      ? `${status.url}/?folder=${encodeURIComponent(projectDir)}`
      : status.url;
    return `
      <section class="kombai-panel running">
        <div class="kombai-bar">
          <div class="kombai-bar-info">
            <span class="live-dot on"></span>
            <strong>Kombai</strong>
            <span>${escapeHtml(`${status.url} | ${projectDir ?? "aucun dossier"}`)}</span>
          </div>
          <div class="kombai-bar-actions">
            <button id="kombaiReload" class="tool-button" title="Recharger l'onglet Kombai">
              <i data-lucide="refresh-ccw"></i><span>Recharger</span>
            </button>
            <button id="kombaiStop" class="tool-button danger" title="Arreter le VS Code embarque">
              <i data-lucide="power"></i><span>Arreter</span>
            </button>
          </div>
        </div>
        <iframe id="kombaiFrame" class="kombai-frame" src="${escapeAttr(src)}" title="Kombai" allow="clipboard-read; clipboard-write"></iframe>
      </section>
    `;
  }

  return `
    <section class="kombai-panel setup">
      <div class="kombai-hero">
        <span class="kombai-hero-icon"><i data-lucide="bot"></i></span>
        <div>
          <h2>Kombai dans l'app</h2>
          <p>Kombai n'a ni CLI ni API : c'est une extension d'IDE. Pour l'utiliser nativement ici, l'app lance un VS Code embarque (code-server) avec l'extension Kombai, affiche dans cet onglet. Aucune fenetre d'editeur externe ne s'ouvre.</p>
        </div>
      </div>

      ${!binaryAvailable
        ? `<div class="kombai-warn">
             <strong>code-server introuvable.</strong> Installe-le une fois, puis reviens ici :
             <code>npm install -g code-server</code>
             <span>(ou renseigne le chemin exact dans le fichier de reglages, cle kombai.codeServerCommand)</span>
           </div>`
        : ""}
      ${status?.message ? `<div class="kombai-note">${escapeHtml(status.message)}</div>` : ""}

      <div class="kombai-meta">
        <div><span>Commande</span><strong>${escapeHtml(command)}</strong></div>
        <div><span>Port</span><strong>${port}</strong></div>
        <div><span>Extension</span><strong>${escapeHtml(extensionId)}</strong></div>
        <div><span>Dossier projet</span><strong>${escapeHtml(projectDir ?? "aucun (compte sans projet)")}</strong></div>
      </div>

      <div class="kombai-actions">
        <button id="kombaiStart" class="tool-button primary" ${binaryAvailable ? "" : "disabled"}>
          <i data-lucide="play"></i><span>${started ? "Redemarrer" : "Demarrer Kombai"}</span>
        </button>
        <button id="kombaiInstall" class="tool-button" ${binaryAvailable ? "" : "disabled"} title="Installer / mettre a jour l'extension Kombai">
          <i data-lucide="upload"></i><span>Installer l'extension</span>
        </button>
        <button id="kombaiRefresh" class="icon-button wide" title="Actualiser le statut">
          <i data-lucide="refresh-ccw"></i>
        </button>
      </div>

      ${started && !running
        ? `<div class="kombai-hint">code-server demarre... l'onglet Kombai s'affichera des qu'il repond (port ${port}).</div>`
        : ""}
      ${!kombaiLoaded ? `<div class="kombai-hint">Lecture du statut...</div>` : ""}
    </section>
  `;
};

const renderPoolPanel = () => {
  const accounts = poolStatus?.accounts ?? [];
  const proxiesEnabled = proxyControlsEnabled();
  const poolProxyOptions =
    settings?.proxies
      .map(
        (item) =>
          `<option value="${escapeAttr(item.id)}" ${item.id === poolNewAccountProxyId ? "selected" : ""}>${escapeHtml(item.label)}</option>`,
      )
      .join("") ?? "";
  return `
    <section class="pool-panel">
      <form id="poolAddAccount" class="pool-add">
        <div class="pool-add-grid">
          <label>
            <span>Nouveau compte</span>
            <input id="poolNewAccountLabel" value="${escapeAttr(poolNewAccountLabel)}" placeholder="Nom du compte" />
          </label>
          <label>
            <span>Proxy</span>
            <select id="poolNewAccountProxy" ${proxiesEnabled ? "" : "disabled"}>
              <option value="" ${poolNewAccountProxyId ? "" : "selected"}>Sans proxy</option>
              ${poolProxyOptions}
            </select>
          </label>
        </div>
        <button class="tool-button" type="submit">
          <i data-lucide="plus"></i><span>Ajouter compte</span>
        </button>
      </form>
      <div class="pool-import">
        <label>
          <span>JSON pool (blob de session colle ou chemin fichier)</span>
          <textarea id="poolImportPaths" rows="5" placeholder="Colle ici le JSON de chatgpt.com/api/auth/session ({&quot;accessToken&quot;:&quot;eyJ...&quot;,...}) ou un chemin C:\\...\\*.json">${escapeHtml(poolImportPaths)}</textarea>
        </label>
        <button id="poolImport" class="tool-button">
          <i data-lucide="upload"></i><span>Importer JSON</span>
        </button>
      </div>
      <table class="pool-table">
        <thead>
          <tr><th>Compte</th><th>État</th><th>Proxy</th><th>Tokens</th><th>Servis</th><th>Erreurs</th><th>Dernière erreur</th><th></th></tr>
        </thead>
        <tbody id="poolRows">
          ${accounts.map(renderPoolRow).join("") ||
          `<tr><td colspan="8" class="pool-empty">Aucun compte. Ajoute un nom de compte, puis attribue un proxy si besoin.</td></tr>`}
        </tbody>
      </table>
    </section>
  `;
};

const renderLimitsPanel = () => {
  const connected = limitStatus.filter((account) => account.hasTokens).length;
  const nextSession = nextLimitTimestamp("sessionResetAt");
  const nextWeekly = nextLimitTimestamp("weeklyResetAt");
  const serverCount = limitStatus.filter((account) => account.source === "server").length;

  return `
    <section class="limits-panel">
      <div class="limits-head">
        <div>
          <strong>Limites comptes</strong>
          <span>${connected}/${settings?.accounts.length ?? 0} comptes connectes · ${serverCount} lus serveur</span>
        </div>
        <div class="limit-summary">
          <div>
            <span>Prochain 5h</span>
            <strong>${formatTimestamp(nextSession)}</strong>
          </div>
          <div>
            <span>Prochain hebdo</span>
            <strong>${formatTimestamp(nextWeekly)}</strong>
          </div>
          <button id="refreshLimits" class="tool-button" title="Actualiser les limites serveur">
            <i data-lucide="refresh-ccw"></i>
            <span>Actualiser</span>
          </button>
        </div>
      </div>
      <table class="limits-table">
        <thead>
          <tr>
            <th>Compte</th>
            <th>Source</th>
            <th>Reset 5h</th>
            <th>Reset hebdo</th>
            <th>Buckets serveur</th>
            <th>Actualise</th>
          </tr>
        </thead>
        <tbody>
          ${renderLimitRows()}
        </tbody>
      </table>
    </section>
  `;
};

const renderLimitRows = () => {
  if (!limitStatusLoaded) {
    return `<tr><td colspan="6" class="pool-empty">Chargement des limites serveur</td></tr>`;
  }

  if (limitStatus.length === 0) {
    return `<tr><td colspan="6" class="pool-empty">Aucun compte</td></tr>`;
  }

  return limitStatus.map(renderLimitRow).join("");
};

const renderLimitRow = (account: AccountLimitView) => `
  <tr class="${account.hasTokens ? "" : "muted"}">
    <td>
      <div class="limit-account">
        <strong>${escapeHtml(account.label)}</strong>
        <small>${escapeHtml(account.codexHome)}</small>
      </div>
    </td>
    <td>
      <span class="limit-badge ${limitBadgeClass(account)}">${escapeHtml(limitSourceLabel(account))}</span>
      ${account.error ? `<small class="limit-error">${escapeHtml(account.error)}</small>` : ""}
    </td>
    <td>
      <strong>${formatTimestamp(account.sessionResetAt)}</strong>
      <small>${formatLimitDetail(account.sessionRemainingSecs, account.sessionUsedPercent)}</small>
    </td>
    <td>
      <strong>${formatTimestamp(account.weeklyResetAt)}</strong>
      <small>${formatLimitDetail(account.weeklyRemainingSecs, account.weeklyUsedPercent)}</small>
    </td>
    <td>
      <div class="limit-buckets">${renderLimitBuckets(account.buckets)}</div>
    </td>
    <td>${formatTimestamp(account.refreshedAt)}</td>
  </tr>
`;

const limitBadgeClass = (account: AccountLimitView) => {
  if (!account.hasTokens) return "missing";
  if (account.source === "server") return "connected";
  if (account.source === "server-empty") return "empty";
  return "error";
};

const limitSourceLabel = (account: AccountLimitView) => {
  if (!account.hasTokens) return "non connecte";
  if (account.source === "server") return "serveur";
  if (account.source === "server-empty") return "vide";
  return "erreur";
};

const formatLimitDetail = (seconds?: number | null, usedPercent?: number | null) => {
  const parts = [];
  if (seconds !== null && seconds !== undefined) parts.push(formatRemaining(seconds));
  if (usedPercent !== null && usedPercent !== undefined) parts.push(`${formatPercent(usedPercent)} utilise`);
  return parts.join(" · ") || "non expose";
};

const renderLimitBuckets = (buckets: AccountRateLimitBucketView[]) => {
  if (buckets.length === 0) return `<span class="limit-empty">aucun bucket</span>`;

  return buckets
    .map(
      (bucket) => `
        <span class="limit-bucket" title="${escapeAttr(`${bucket.limitId} ${bucket.bucket}`)}">
          ${escapeHtml(formatWindow(bucket.windowDurationMins))}
          ${escapeHtml(formatPercent(bucket.usedPercent))}
          <small>${escapeHtml(formatTimestamp(bucket.resetsAt))}</small>
        </span>
      `,
    )
    .join("");
};

const formatWindow = (minutes: number) => {
  if (minutes === 300) return "5h";
  if (minutes === 10080) return "hebdo";
  if (minutes % 1440 === 0) return `${minutes / 1440}j`;
  if (minutes % 60 === 0) return `${minutes / 60}h`;
  return `${minutes}min`;
};

const formatPercent = (value?: number | null) => {
  if (value === null || value === undefined || !Number.isFinite(value)) return "n/a";
  return `${Math.round(value)}%`;
};

const nextLimitTimestamp = (key: "sessionResetAt" | "weeklyResetAt") => {
  const values = limitStatus
    .filter((account) => account.hasTokens)
    .map((account) => account[key])
    .filter((value): value is number => typeof value === "number" && Number.isFinite(value));

  return values.length > 0 ? Math.min(...values) : null;
};

const formatTimestamp = (timestamp?: number | null) => {
  if (!timestamp) return "n/a";
  return new Intl.DateTimeFormat("fr-FR", {
    day: "2-digit",
    month: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(timestamp * 1000));
};

const formatRemaining = (seconds?: number | null) => {
  if (seconds === null || seconds === undefined) return "n/a";
  const total = Math.max(0, Math.floor(seconds));
  const days = Math.floor(total / 86400);
  const hours = Math.floor((total % 86400) / 3600);
  const minutes = Math.floor((total % 3600) / 60);

  if (days > 0) return `${days}j ${hours}h`;
  if (hours > 0) return `${hours}h ${minutes}min`;
  return `${minutes}min`;
};

// Tokens/coût agrégés par date à partir des logs Codex par-compte
// (account_usage.rs). Source complète : couvre aussi les comptes utilisés
// interactivement via `codex login`, contrairement au trafic pool.
type DayTokenTotals = {
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  totalTokens: number;
  costUsd: number;
};

const aggregateAccountDaysByDate = (
  data: AccountUsageDashboard,
): Map<string, DayTokenTotals> => {
  const byDate = new Map<string, DayTokenTotals>();
  for (const account of data.accounts) {
    for (const day of account.days) {
      const entry =
        byDate.get(day.date) ??
        { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, totalTokens: 0, costUsd: 0 };
      entry.inputTokens += day.inputTokens;
      entry.cachedInputTokens += day.cachedInputTokens;
      entry.outputTokens += day.outputTokens;
      entry.totalTokens += day.totalTokens;
      entry.costUsd += day.costUsd;
      byDate.set(day.date, entry);
    }
  }
  return byDate;
};

// Remplace (jamais additionne, pour éviter tout double comptage) les
// tokens/coût d'une journée par la valeur issue des comptes. Les compteurs
// propres au pool (temps agents, requêtes API…) sont conservés tels quels.
const mergeDayTokens = (day: UsageDayView, tokens: DayTokenTotals | undefined): UsageDayView => ({
  ...day,
  inputTokens: tokens?.inputTokens ?? 0,
  cachedInputTokens: tokens?.cachedInputTokens ?? 0,
  outputTokens: tokens?.outputTokens ?? 0,
  totalTokens: tokens?.totalTokens ?? 0,
  costUsd: tokens?.costUsd ?? 0,
});

// « Général » = somme de tous les comptes. On garde la structure mois-à-date du
// pool (temps agents / requêtes API) et on y superpose les tokens/coût réels
// relus des logs Codex. Repli sur les données pool tant que le scan par-compte
// n'est pas chargé, ou s'il n'y a aucun compte.
const buildMergedUsageDashboard = (
  pool: UsageDashboard,
  accounts: AccountUsageDashboard | null,
): UsageDashboard => {
  if (!accounts || accounts.accounts.length === 0) {
    return pool;
  }
  const byDate = aggregateAccountDaysByDate(accounts);
  const days = pool.days.map((day) => mergeDayTokens(day, byDate.get(day.date)));
  const today = mergeDayTokens(pool.today, byDate.get(pool.today.date));
  return {
    ...pool,
    totalTokens: days.reduce((sum, day) => sum + day.totalTokens, 0),
    totalCostUsd: days.reduce((sum, day) => sum + day.costUsd, 0),
    today,
    days,
  };
};

const renderDashboardPanel = () => {
  if (!usageLoaded || !usageDashboard) {
    return `<section class="dashboard-panel"><div class="pool-empty">Chargement dashboard</div></section>`;
  }

  const dash = buildMergedUsageDashboard(usageDashboard, accountUsageLoaded ? accountUsage : null);

  const days = dash.days.length > 0 ? dash.days : [dash.today];
  const chartDays = days.slice(-30);
  const monthLabel = formatMonthLabel(days[0]?.date ?? dash.today.date);
  const errorRate =
    dash.totalApiRequests > 0
      ? Math.round((dash.totalApiErrors / dash.totalApiRequests) * 100)
      : 0;

  return `
    <section class="dashboard-panel">
      <div class="metric-grid">
        ${renderMetricCard("Temps agents", formatDuration(dash.totalAgentSeconds), `${dash.totalAgentRuns} sessions ce mois`, `${dash.activeAgentCount} actives`, "clock-3")}
        ${renderMetricCard("Tokens du jour", formatTokens(dash.today.totalTokens), `${formatTokens(dash.today.inputTokens)} entree | ${formatTokens(dash.today.outputTokens)} sortie`, `${dash.today.apiRequests} API`, "bar-chart-3")}
        ${renderMetricCard("Cout du jour", formatUsd(dash.today.costUsd), `${dash.today.estimatedRequests} estimation(s)`, "aujourd'hui", "circle-dollar-sign")}
        ${renderMetricCard("Cout du mois", formatUsd(dash.totalCostUsd), `${formatTokens(dash.totalTokens)} tokens`, `${errorRate}% err`, "server")}
      </div>

      <section class="usage-chart-card">
        <div class="dashboard-card-head">
          <div>
            <strong>Total tokens</strong>
            <span>${escapeHtml(monthLabel)} | ${formatTokens(dash.totalTokens)} consommes</span>
          </div>
          <div class="dashboard-segment">
            <button class="active">30 jours</button>
            <button>14 jours</button>
            <button>7 jours</button>
          </div>
        </div>
        ${renderUsageAreaChart(chartDays)}
      </section>

      <div class="dashboard-table-toolbar">
        <div class="dashboard-table-actions">
          <button id="dashboardRefresh"><i data-lucide="refresh-ccw"></i><span>Actualiser</span></button>
        </div>
      </div>

      <div class="usage-table-wrap">
        <table class="usage-table">
          <thead>
            <tr>
              <th>Jour</th>
              <th>Temps agent</th>
              <th>API</th>
              <th>Tokens</th>
              <th>Entree</th>
              <th>Cache</th>
              <th>Sortie</th>
              <th>Cout</th>
            </tr>
          </thead>
          <tbody>
            ${days.map(renderUsageDayRow).join("")}
          </tbody>
        </table>
      </div>

      ${renderAccountUsagePanel()}
    </section>
  `;
};

const renderAccountUsagePanel = () => {
  if (!accountUsageLoaded) {
    return `
      <section class="account-usage-card">
        <div class="dashboard-card-head">
          <div><strong>Tokens par compte</strong><span>Lecture des sessions Codex…</span></div>
        </div>
      </section>
    `;
  }

  const data = accountUsage;
  if (!data || data.accounts.length === 0) {
    return `
      <section class="account-usage-card">
        <div class="dashboard-card-head">
          <div><strong>Tokens par compte</strong><span>Aucune session Codex trouvee</span></div>
          <div class="dashboard-table-actions">
            <button id="accountUsageRefresh"><i data-lucide="refresh-ccw"></i><span>Actualiser</span></button>
          </div>
        </div>
      </section>
    `;
  }

  return `
    <section class="account-usage-card">
      <div class="dashboard-card-head">
        <div>
          <strong>Tokens par compte</strong>
          <span>${data.accounts.length} compte(s) · ${escapeHtml(formatTokens(data.totalTokens))} tokens · ${data.totalSessions} sessions · ${escapeHtml(formatUsd(data.totalCostUsd))}</span>
        </div>
        <div class="dashboard-table-actions">
          <button id="accountUsageRefresh"><i data-lucide="refresh-ccw"></i><span>Actualiser</span></button>
        </div>
      </div>
      <div class="usage-table-wrap">
        <table class="usage-table">
          <thead>
            <tr>
              <th>Compte</th>
              <th>Sessions</th>
              <th>Total tokens</th>
              <th>Entree</th>
              <th>Cache</th>
              <th>Sortie</th>
              <th>Cout total</th>
              <th>Ce mois</th>
              <th>Derniere activite</th>
            </tr>
          </thead>
          <tbody>
            ${data.accounts.map(renderAccountUsageRow).join("")}
          </tbody>
        </table>
      </div>
      <p class="account-usage-hint">Reconstruit depuis les logs de session Codex (CODEX_HOME/sessions). Le cout est une estimation.</p>
    </section>
  `;
};

const renderAccountUsageRow = (account: AccountUsageView) => {
  if (account.error) {
    return `
      <tr class="muted">
        <td><div class="limit-account"><strong>${escapeHtml(account.label)}</strong><small>${escapeHtml(account.codexHome)}</small></div></td>
        <td colspan="8"><small class="limit-error">${escapeHtml(account.error)}</small></td>
      </tr>
    `;
  }

  return `
    <tr class="${account.totalTokens > 0 ? "" : "muted"}">
      <td>
        <div class="limit-account">
          <strong>${escapeHtml(account.label)}${account.hasTokens ? "" : " <small>(deconnecte)</small>"}</strong>
          <small>${escapeHtml(account.codexHome)}</small>
        </div>
      </td>
      <td>${account.sessionCount}</td>
      <td>${escapeHtml(formatTokens(account.totalTokens))}</td>
      <td>${escapeHtml(formatTokens(account.inputTokens))}</td>
      <td>${escapeHtml(formatTokens(account.cachedInputTokens))}</td>
      <td>${escapeHtml(formatTokens(account.outputTokens))}</td>
      <td>${escapeHtml(formatUsd(account.costUsd))}</td>
      <td>${escapeHtml(formatTokens(account.monthTokens))}${account.monthCostUsd > 0 ? `<small>${escapeHtml(formatUsd(account.monthCostUsd))}</small>` : ""}</td>
      <td>${account.lastActivity ? escapeHtml(formatTimestamp(account.lastActivity)) : "n/a"}</td>
    </tr>
  `;
};

const renderMetricCard = (label: string, value: string, detail: string, badge: string, icon: string) => `
  <div class="metric-card">
    <div class="metric-card-top">
      <span>${escapeHtml(label)}</span>
      <em><i data-lucide="${icon}"></i>${escapeHtml(badge)}</em>
    </div>
    <strong>${escapeHtml(value)}</strong>
    <small>${escapeHtml(detail)}</small>
  </div>
`;

const renderUsageAreaChart = (days: UsageDayView[]) => {
  const chartDays = days.length > 0 ? days : [];
  if (chartDays.length === 0) {
    return `<div class="usage-area-chart empty">Aucune donnee</div>`;
  }

  const width = 960;
  const height = 246;
  const padX = 28;
  const padTop = 26;
  const padBottom = 38;
  const bottom = height - padBottom;
  const innerWidth = width - padX * 2;
  const maxTokens = Math.max(1, ...chartDays.map((day) => day.totalTokens));
  const points = chartDays.map((day, index) => {
    const x = padX + (chartDays.length === 1 ? innerWidth / 2 : (index / (chartDays.length - 1)) * innerWidth);
    const y = bottom - (day.totalTokens / maxTokens) * (bottom - padTop);
    return { day, x, y };
  });
  const linePath = points.map((point, index) => `${index === 0 ? "M" : "L"} ${point.x.toFixed(2)} ${point.y.toFixed(2)}`).join(" ");
  const areaPath = `${linePath} L ${points[points.length - 1].x.toFixed(2)} ${bottom} L ${points[0].x.toFixed(2)} ${bottom} Z`;
  const gridLines = [0, 1, 2, 3].map((step) => {
    const y = padTop + ((bottom - padTop) / 3) * step;
    return `<line x1="${padX}" y1="${y.toFixed(2)}" x2="${width - padX}" y2="${y.toFixed(2)}" />`;
  });
  const labelStep = Math.max(1, Math.ceil(chartDays.length / 7));
  const labels = points
    .filter((_, index) => index % labelStep === 0 || index === points.length - 1)
    .map(
      (point) =>
        `<text x="${point.x.toFixed(2)}" y="${height - 11}" text-anchor="middle">${escapeHtml(formatDayLabel(point.day.date))}</text>`,
    );

  return `
    <div class="usage-area-chart">
      <svg viewBox="0 0 ${width} ${height}" role="img" aria-label="Usage tokens">
        <g class="chart-grid">${gridLines.join("")}</g>
        <path class="chart-area" d="${areaPath}"></path>
        <path class="chart-line" d="${linePath}"></path>
        <g class="chart-points">${points.map((point) => `<circle cx="${point.x.toFixed(2)}" cy="${point.y.toFixed(2)}" r="2.3" />`).join("")}</g>
        <g class="chart-labels">${labels.join("")}</g>
      </svg>
    </div>
  `;
};

const renderUsageDayRow = (day: UsageDayView) => `
  <tr>
    <td>${escapeHtml(formatDayLabel(day.date))}</td>
    <td>${escapeHtml(formatDuration(day.agentRunSeconds))}<small>${day.agentRuns} run</small></td>
    <td>${day.apiRequests}<small>${day.apiErrors ? `${day.apiErrors} err` : ""}</small></td>
    <td>${escapeHtml(formatTokens(day.totalTokens))}${day.estimatedRequests ? `<small>${day.estimatedRequests} est.</small>` : ""}</td>
    <td>${escapeHtml(formatTokens(day.inputTokens))}</td>
    <td>${escapeHtml(formatTokens(day.cachedInputTokens))}</td>
    <td>${escapeHtml(formatTokens(day.outputTokens))}</td>
    <td>${escapeHtml(formatUsd(day.costUsd))}</td>
  </tr>
`;

const formatDuration = (seconds: number) => {
  const total = Math.max(0, Math.floor(seconds));
  const days = Math.floor(total / 86400);
  const hours = Math.floor((total % 86400) / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const secs = total % 60;

  if (days > 0) return `${days}j ${hours}h`;
  if (hours > 0) return `${hours}h ${minutes}min`;
  if (minutes > 0) return `${minutes}min ${secs}s`;
  return `${secs}s`;
};

const formatTokens = (value: number) =>
  new Intl.NumberFormat("fr-FR", { maximumFractionDigits: 0 }).format(Math.max(0, Math.round(value)));

const formatUsd = (value: number) =>
  new Intl.NumberFormat("fr-FR", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: value > 0 && value < 1 ? 4 : 2,
    maximumFractionDigits: value > 0 && value < 1 ? 4 : 2,
  }).format(Number.isFinite(value) ? value : 0);

const formatDayLabel = (date: string) => {
  const parsed = new Date(`${date}T12:00:00`);
  if (Number.isNaN(parsed.getTime())) return date;
  return new Intl.DateTimeFormat("fr-FR", {
    day: "2-digit",
    month: "short",
  }).format(parsed);
};

const formatMonthLabel = (date: string) => {
  const parsed = new Date(`${date}T12:00:00`);
  if (Number.isNaN(parsed.getTime())) return "Mois courant";
  return new Intl.DateTimeFormat("fr-FR", {
    month: "long",
    year: "numeric",
  }).format(parsed);
};

const defaultCodexHomeForLabel = (label: string) => {
  const slug = label
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
  return isRemoteMode()
    ? `${userHomeHint()}/${slug || "account"}`
    : `${userHomeHint()}\\.codex-${slug || "account"}`;
};

const normalizeCodexHome = (value: string) => value.trim().replaceAll("/", "\\").toLowerCase();

const uniqueCodexHomeForLabel = (label: string) => {
  const used = new Set((settings?.accounts ?? []).map((account) => normalizeCodexHome(account.codexHome)));
  let candidate = defaultCodexHomeForLabel(label);
  if (!used.has(normalizeCodexHome(candidate))) return candidate;

  for (let index = 2; index < 1000; index += 1) {
    candidate = defaultCodexHomeForLabel(`${label}-${index}`);
    if (!used.has(normalizeCodexHome(candidate))) return candidate;
  }

  return defaultCodexHomeForLabel(`${label}-${Date.now().toString(36)}`);
};

const newAccountProfile = (
  label: string,
  codexHome = defaultCodexHomeForLabel(label),
  projectDir: string | null = null,
  proxyId: string | null = null,
): AccountProfile => ({
  id: uid("account"),
  label,
  codexHome,
  projectDir,
  proxyId,
  startupCommand: null,
  // Nouveau compte : herite du defaut global (ON par defaut).
  bypass: settings?.codexBypass ?? true,
});

const refreshPoolAfterAccountChange = async (message: string) => {
  if (poolStatus?.running) {
    poolStatus = await invoke<PoolStatus>("pool_start");
    startPoolPoll();
  } else {
    poolStatus = await invoke<PoolStatus>("pool_status");
  }

  statusText = message;
  render();
};

const readPoolNewAccountForm = () => {
  poolNewAccountLabel =
    document.querySelector<HTMLInputElement>("#poolNewAccountLabel")?.value.trim() ?? poolNewAccountLabel;
  poolNewAccountProxyId =
    document.querySelector<HTMLSelectElement>("#poolNewAccountProxy")?.value ?? poolNewAccountProxyId;
};

const clearPoolNewAccountForm = () => {
  poolNewAccountLabel = "";
  poolNewAccountProxyId = "";
};

const addPoolAccount = async () => {
  if (!settings) return;
  readPoolForm();
  readPoolNewAccountForm();

  const label = poolNewAccountLabel || "Nouveau compte";
  const codexHome = uniqueCodexHomeForLabel(label);
  const proxyId = settings.proxyControlsEnabled ? poolNewAccountProxyId || null : null;

  try {
    await invoke("ensure_account_home", { codexHome });
    const account = newAccountProfile(label, codexHome, null, proxyId);
    settings.accounts.push(account);
    settings.defaultAccountId = account.id;
    selectedAccountId = account.id;
    settings = await invoke<AppSettings>("save_settings", { settings });
    clearPoolNewAccountForm();
    await refreshPoolAfterAccountChange(`Compte ${label} ajoute au pool`);
  } catch (error) {
    statusText = String(error);
    render();
  }
};

const openNewTerminalModal = () => {
  if (!settings) return;
  newTerminalAccountId = selectedAccountId || settings.defaultAccountId || settings.accounts[0]?.id || null;
  newTerminalAgentId = settings.activeAgentId || settings.agents[0]?.id || null;
  newTerminalModalOpen = true;
  statusText = "Choisis l'agent et le compte du nouveau terminal";
  render();
};

const closeNewTerminalModal = () => {
  newTerminalModalOpen = false;
  render();
};

const openAgentsModal = () => {
  if (!settings) return;
  agentsModalOpen = true;
  statusText = "Gestion des agents";
  render();
};

const closeAgentsModal = () => {
  agentsModalOpen = false;
  render();
};

const readAgentsModalForm = () => {
  if (!settings) return;
  document.querySelectorAll<HTMLElement>("[data-agent-id]").forEach((element) => {
    const input = element as HTMLInputElement | HTMLSelectElement;
    const id = input.dataset.agentId;
    const field = input.dataset.agentField;
    const agent = settings?.agents.find((candidate) => candidate.id === id);
    if (!agent || !field) return;
    if (field === "label") {
      const value = input.value.trim();
      if (value || !agent.builtin) agent.label = value || agent.label;
    } else if (field === "command") {
      agent.command = input.value.trim();
    } else if (field === "kind" && !agent.builtin) {
      agent.kind = input.value === "ide" ? "ide" : "cli";
    }
  });
};

const addAgent = () => {
  if (!settings) return;
  readAgentsModalForm();
  settings.agents.push({
    id: uid("agent"),
    label: "Nouvel agent",
    command: "",
    kind: "cli",
    builtin: false,
    loginCommand: null,
    statusCommand: null,
    doctorCommand: null,
  });
  statusText = "Agent ajoute";
  render();
};

const removeAgent = (id: string | null) => {
  if (!settings || !id) return;
  const agent = settings.agents.find((candidate) => candidate.id === id);
  if (!agent || agent.builtin) return;
  readAgentsModalForm();
  settings.agents = settings.agents.filter((candidate) => candidate.id !== id);
  if (settings.activeAgentId === id) {
    settings.activeAgentId = settings.agents[0]?.id ?? null;
  }
  statusText = "Agent supprime";
  render();
};

const saveAgentsModal = async () => {
  if (!settings) return;
  readAgentsModalForm();
  // Un agent non integre sans commande ne peut pas etre lance : on l'ecarte
  // pour eviter qu'un "run" retombe silencieusement sur Codex.
  settings.agents = settings.agents.filter((agent) => agent.builtin || agent.command.trim());
  agentsModalOpen = false;
  await saveSettings();
};

const readNewTerminalModalForm = () => {
  if (!settings || !newTerminalAccountId) return null;
  const account = settings.accounts.find((candidate) => candidate.id === newTerminalAccountId);
  if (!account) return null;

  account.codexHome =
    document.querySelector<HTMLInputElement>("#newTerminalCodexHome")?.value.trim() ||
    account.codexHome ||
    defaultCodexHomeForLabel(account.label);
  account.projectDir =
    document.querySelector<HTMLInputElement>("#newTerminalProjectDir")?.value.trim() || null;
  if (settings.proxyControlsEnabled) {
    account.proxyId = document.querySelector<HTMLSelectElement>("#newTerminalProxy")?.value || null;
  }
  const agentSelect = document.querySelector<HTMLSelectElement>("#newTerminalAgent");
  if (agentSelect) newTerminalAgentId = agentSelect.value || newTerminalAgentId;
  settings.autoRunCodex = document.querySelector<HTMLInputElement>("#newTerminalAutoRun")?.checked ?? settings.autoRunCodex;
  return account;
};

const addAccountFromModal = () => {
  if (!settings) return;
  const label = document.querySelector<HTMLInputElement>("#newTerminalAccountLabel")?.value.trim();
  if (!label) {
    statusText = "Nom de compte manquant";
    render();
    return;
  }

  const account = newAccountProfile(label);
  settings.accounts.push(account);
  selectedAccountId = account.id;
  newTerminalAccountId = account.id;
  statusText = "Compte ajoute pour le nouveau terminal";
  render();
};

const bindUi = () => {
  document.querySelectorAll<HTMLButtonElement>("[data-account]").forEach((button) => {
    button.addEventListener("click", () => {
      selectedAccountId = button.dataset.account ?? null;
      statusText = "Compte selectionne";
      render();
    });
  });

  document.querySelectorAll<HTMLButtonElement>("[data-terminal-key]").forEach((button) => {
    button.addEventListener("click", () => {
      activeTerminalKey = button.dataset.terminalKey ?? null;
      const session = activeTerminal();
      if (session) {
        selectedAccountId = session.accountId;
        if (settings && session.agentId && settings.agents.some((agent) => agent.id === session.agentId)) {
          settings.activeAgentId = session.agentId;
        }
      }
      statusText = "Terminal selectionne";
      render();
      persistTerminalSessions();
    });
  });

  document.querySelectorAll<HTMLButtonElement>("[data-close-terminal]").forEach((button) => {
    button.addEventListener("click", () => {
      const key = button.dataset.closeTerminal;
      if (key) void closeTerminalSession(key);
    });
  });

  document.querySelector<HTMLButtonElement>("#addAccount")?.addEventListener("click", () => {
    if (!settings) return;
    const account = newAccountProfile(
      "Nouveau compte",
      isRemoteMode() ? `${userHomeHint()}/new` : `${userHomeHint()}\\.codex-new`,
    );
    settings.accounts.push(account);
    selectedAccountId = account.id;
    statusText = "Compte ajoute";
    render();
  });

  document.querySelector<HTMLButtonElement>("#addProxy")?.addEventListener("click", () => {
    if (!settings || !proxyControlsEnabled()) return;
    const proxyUrl = window.prompt("URL proxy", "http://user:pass@host:port");
    if (!proxyUrl) return;
    const id = uid("proxy");
    settings.proxies.push({
      id,
      label: "Proxy",
      proxyUrl,
      note: null,
    });
    const account = selectedAccount();
    if (account) account.proxyId = id;
    statusText = "Proxy ajoute";
    render();
  });

  document.querySelector<HTMLButtonElement>("#pickProjectDir")?.addEventListener("click", () => {
    void pickProjectDir();
  });

  document.querySelector<HTMLButtonElement>("#workspacePick")?.addEventListener("click", () => {
    void openWorkspacePicker();
  });

  document.querySelector<HTMLButtonElement>("#workspaceClear")?.addEventListener("click", () => {
    chooseWorkspace(null);
  });

  document.querySelectorAll<HTMLButtonElement>("[data-ws-dir]").forEach((button) => {
    button.addEventListener("click", () => {
      const path = button.dataset.wsDir;
      if (path) void loadWorkspaceDir(path);
    });
  });

  document.querySelector<HTMLButtonElement>("#workspaceGo")?.addEventListener("click", () => {
    const value = document.querySelector<HTMLInputElement>("#workspacePathInput")?.value.trim();
    void loadWorkspaceDir(value || null);
  });

  document.querySelector<HTMLInputElement>("#workspacePathInput")?.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      const value = (event.currentTarget as HTMLInputElement).value.trim();
      void loadWorkspaceDir(value || null);
    }
  });

  document.querySelector<HTMLButtonElement>("#confirmWorkspaceModal")?.addEventListener("click", () => {
    const path = workspaceBrowse?.path?.trim();
    if (path) chooseWorkspace(path);
  });

  document.querySelector<HTMLButtonElement>("#clearWorkspaceModal")?.addEventListener("click", () => {
    chooseWorkspace(null);
  });

  document.querySelector<HTMLButtonElement>("#cancelWorkspaceModal")?.addEventListener("click", () => {
    closeWorkspaceModal();
  });

  document.querySelector<HTMLButtonElement>("#closeWorkspaceModal")?.addEventListener("click", () => {
    closeWorkspaceModal();
  });

  document.querySelector<HTMLDivElement>("#workspaceBackdrop")?.addEventListener("click", (event) => {
    if (event.target === event.currentTarget) {
      closeWorkspaceModal();
    }
  });

  document.querySelector<HTMLButtonElement>("#newTerminal")?.addEventListener("click", () => {
    openNewTerminalModal();
  });

  document.querySelector<HTMLButtonElement>("#newTerminalSide")?.addEventListener("click", () => {
    openNewTerminalModal();
  });

  document.querySelector<HTMLButtonElement>("#closeNewTerminalModal")?.addEventListener("click", () => {
    closeNewTerminalModal();
  });

  document.querySelector<HTMLButtonElement>("#cancelNewTerminal")?.addEventListener("click", () => {
    closeNewTerminalModal();
  });

  document.querySelector<HTMLDivElement>("#newTerminalBackdrop")?.addEventListener("click", (event) => {
    if (event.target === event.currentTarget) {
      closeNewTerminalModal();
    }
  });

  document.querySelector<HTMLSelectElement>("#newTerminalAccount")?.addEventListener("change", (event) => {
    newTerminalAccountId = (event.currentTarget as HTMLSelectElement).value || null;
    render();
  });

  document.querySelector<HTMLSelectElement>("#newTerminalAgent")?.addEventListener("change", (event) => {
    // Committe les champs saisis (CODEX_HOME, projet, proxy) avant le re-render,
    // sinon changer d'agent (qui ne change pas de compte) les remettrait a zero.
    readNewTerminalModalForm();
    newTerminalAgentId = (event.currentTarget as HTMLSelectElement).value || null;
    render();
  });

  document.querySelector<HTMLButtonElement>("#addAccountFromModal")?.addEventListener("click", () => {
    addAccountFromModal();
  });

  document.querySelector<HTMLButtonElement>("#confirmNewTerminal")?.addEventListener("click", () => {
    const account = readNewTerminalModalForm();
    if (!account) {
      statusText = "Choisis ou ajoute un compte";
      render();
      return;
    }
    newTerminalModalOpen = false;
    void createNewTerminal(account.id, true, null, newTerminalAgentId);
  });

  document.querySelector<HTMLButtonElement>("#loginNewTerminal")?.addEventListener("click", () => {
    const account = readNewTerminalModalForm();
    if (!account || !settings) {
      statusText = "Choisis ou ajoute un compte";
      render();
      return;
    }
    const agent = newTerminalAgent();
    if (!agent?.loginCommand) {
      statusText = "Cet agent n'a pas de commande de login";
      render();
      return;
    }
    newTerminalModalOpen = false;
    void createNewTerminal(account.id, true, agentSubcommand(agent, agent.loginCommand), agent.id);
  });

  document.querySelector<HTMLButtonElement>("#poolTerminal")?.addEventListener("click", () => {
    void createPoolTerminal();
  });

  document.querySelector<HTMLButtonElement>("#fullscreenToggle")?.addEventListener("click", () => {
    void toggleFullscreen();
  });

  document.querySelector<HTMLButtonElement>("#poolToggle")?.addEventListener("click", () => {
    setActiveView("pool");
  });

  document.querySelector<HTMLButtonElement>("#limitsToggle")?.addEventListener("click", () => {
    setActiveView("limits");
  });

  document.querySelector<HTMLButtonElement>("#refreshLimits")?.addEventListener("click", () => {
    void refreshLimitStatus();
  });

  document.querySelector<HTMLButtonElement>("#dashboardToggle")?.addEventListener("click", () => {
    setActiveView("dashboard");
  });

  document.querySelector<HTMLButtonElement>("#dashboardRefresh")?.addEventListener("click", () => {
    // Le « général » agrège désormais les tokens/coût par-compte : on relit
    // aussi les logs Codex pour que le rafraîchissement mette tout à jour.
    void refreshUsageDashboard();
    void refreshAccountUsage();
  });

  document.querySelector<HTMLButtonElement>("#kombaiToggle")?.addEventListener("click", () => {
    setActiveView("kombai");
  });

  document.querySelector<HTMLButtonElement>("#roomToggle")?.addEventListener("click", () => {
    setActiveView("room");
  });

  document.querySelector<HTMLButtonElement>("#roomRefresh")?.addEventListener("click", () => {
    void refreshRoom();
  });

  document.querySelector<HTMLButtonElement>("#roomToggleEnabled")?.addEventListener("click", () => {
    if (settings?.agentRoom?.enabled) {
      void disableRoom();
    } else {
      void enableRoom();
    }
  });

  document.querySelector<HTMLSelectElement>("#roomTarget")?.addEventListener("change", (event) => {
    roomComposeTarget = (event.target as HTMLSelectElement).value;
  });

  document.querySelector<HTMLFormElement>("#roomComposer")?.addEventListener("submit", (event) => {
    event.preventDefault();
    void sendRoomMessage();
  });

  document.querySelector<HTMLButtonElement>("#kombaiStart")?.addEventListener("click", () => {
    void startKombai();
  });

  document.querySelector<HTMLButtonElement>("#kombaiStop")?.addEventListener("click", () => {
    void stopKombai();
  });

  document.querySelector<HTMLButtonElement>("#kombaiInstall")?.addEventListener("click", () => {
    void installKombaiExtension();
  });

  document.querySelector<HTMLButtonElement>("#kombaiRefresh")?.addEventListener("click", () => {
    void refreshKombaiStatus();
  });

  document.querySelector<HTMLButtonElement>("#kombaiReload")?.addEventListener("click", () => {
    reloadKombaiFrame();
  });

  document.querySelector<HTMLButtonElement>("#discussionsToggle")?.addEventListener("click", () => {
    setActiveView("discussions");
  });

  document.querySelector<HTMLButtonElement>("#refreshDiscussions")?.addEventListener("click", () => {
    void refreshDiscussions();
  });

  document.querySelector<HTMLInputElement>("#discussionSearch")?.addEventListener("input", (event) => {
    discussionSearch = (event.currentTarget as HTMLInputElement).value;
    refreshDiscussionList();
  });

  bindDiscussionRowUi();

  document.querySelector<HTMLButtonElement>("#historyToggle")?.addEventListener("click", () => {
    setActiveView("history");
  });

  document.querySelector<HTMLButtonElement>("#refreshPromptHistory")?.addEventListener("click", () => {
    promptHistoryLoaded = false;
    void refreshPromptHistory();
  });

  document.querySelector<HTMLInputElement>("#promptSearch")?.addEventListener("input", (event) => {
    promptSearch = (event.currentTarget as HTMLInputElement).value;
    refreshPromptList();
  });

  bindPromptRowUi();

  document.querySelector<HTMLButtonElement>("#accountUsageRefresh")?.addEventListener("click", () => {
    void refreshAccountUsage();
  });

  document.querySelector<HTMLButtonElement>("#poolStart")?.addEventListener("click", () => {
    void startPool();
  });

  document.querySelector<HTMLButtonElement>("#poolStop")?.addEventListener("click", () => {
    void stopPool();
  });

  document.querySelector<HTMLButtonElement>("#poolTest")?.addEventListener("click", () => {
    void testPool();
  });

  document.querySelector<HTMLFormElement>("#poolAddAccount")?.addEventListener("submit", (event) => {
    event.preventDefault();
    void addPoolAccount();
  });

  document
    .querySelectorAll<HTMLInputElement | HTMLSelectElement>(
      "#poolNewAccountLabel, #poolNewAccountProxy",
    )
    .forEach((input) => {
      input.addEventListener("input", readPoolNewAccountForm);
      input.addEventListener("change", readPoolNewAccountForm);
    });

  document.querySelector<HTMLTextAreaElement>("#poolImportPaths")?.addEventListener("input", (event) => {
    poolImportPaths = (event.currentTarget as HTMLTextAreaElement).value;
  });

  document.querySelector<HTMLButtonElement>("#poolImport")?.addEventListener("click", () => {
    void importPoolFiles();
  });

  // Delegation : le tbody #poolRows est reecrit par le poll 3s (innerHTML), donc
  // on ecoute sur le conteneur qui, lui, persiste entre deux rafraichissements.
  document.querySelector<HTMLTableSectionElement>("#poolRows")?.addEventListener("click", (event) => {
    const target = event.target as HTMLElement;
    const confirmBtn = target.closest<HTMLElement>("[data-remove-account-confirm]");
    if (confirmBtn) {
      void removeAccount(confirmBtn.dataset.removeAccountConfirm ?? null);
      return;
    }
    const cancelBtn = target.closest<HTMLElement>("[data-remove-account-cancel]");
    if (cancelBtn) {
      pendingDeleteAccountId = null;
      render();
      return;
    }
    const removeBtn = target.closest<HTMLElement>("[data-remove-account]");
    if (removeBtn) {
      pendingDeleteAccountId = removeBtn.dataset.removeAccount ?? null;
      render();
    }
  });

  document.querySelector<HTMLSelectElement>("#agentSelect")?.addEventListener("change", (event) => {
    setActiveAgent((event.currentTarget as HTMLSelectElement).value || null);
  });

  document.querySelector<HTMLButtonElement>("#runAgent")?.addEventListener("click", () => {
    const agent = activeAgent();
    if (!agent) return;
    if (agentIsIde(agent)) {
      void launchIde(agent);
    } else {
      void sendLine(agentRunCommand(agent, accountById(activeTerminal()?.accountId)));
    }
  });

  document.querySelector<HTMLButtonElement>("#manageAgents")?.addEventListener("click", () => {
    openAgentsModal();
  });

  document.querySelector<HTMLButtonElement>("#loginStatus")?.addEventListener("click", () => {
    const agent = activeAgent();
    if (agent?.statusCommand) void sendLine(agentSubcommand(agent, agent.statusCommand));
  });

  document.querySelector<HTMLButtonElement>("#doctor")?.addEventListener("click", () => {
    const agent = activeAgent();
    if (agent?.doctorCommand) void sendLine(agentSubcommand(agent, agent.doctorCommand));
  });

  document.querySelector<HTMLButtonElement>("#closeAgentsModal")?.addEventListener("click", () => {
    closeAgentsModal();
  });

  document.querySelector<HTMLButtonElement>("#cancelAgentsModal")?.addEventListener("click", () => {
    closeAgentsModal();
  });

  document.querySelector<HTMLDivElement>("#agentsBackdrop")?.addEventListener("click", (event) => {
    if (event.target === event.currentTarget) {
      closeAgentsModal();
    }
  });

  document.querySelector<HTMLButtonElement>("#addAgent")?.addEventListener("click", () => {
    addAgent();
  });

  document.querySelectorAll<HTMLButtonElement>("[data-remove-agent]").forEach((button) => {
    button.addEventListener("click", () => {
      removeAgent(button.dataset.removeAgent ?? null);
    });
  });

  document.querySelectorAll<HTMLSelectElement>('[data-agent-field="kind"]').forEach((select) => {
    select.addEventListener("change", () => {
      readAgentsModalForm();
      render();
    });
  });

  document.querySelector<HTMLButtonElement>("#saveAgentsModal")?.addEventListener("click", () => {
    void saveAgentsModal();
  });

  document.querySelector<HTMLButtonElement>("#saveSettings")?.addEventListener("click", () => {
    readSettingsForm();
    void saveSettings();
  });

  document.querySelector<HTMLButtonElement>("#removeAccount")?.addEventListener("click", () => {
    if (!settings || !selectedAccountId) return;
    settings.accounts = settings.accounts.filter((account) => account.id !== selectedAccountId);
    selectedAccountId = settings.accounts[0]?.id ?? null;
    statusText = "Compte retire";
    render();
  });

  document.querySelector<HTMLInputElement>("#autoRun")?.addEventListener("change", (event) => {
    if (!settings) return;
    settings.autoRunCodex = (event.currentTarget as HTMLInputElement).checked;
  });

  document.querySelector<HTMLInputElement>("#proxyControls")?.addEventListener("change", (event) => {
    if (!settings) return;
    settings.proxyControlsEnabled = (event.currentTarget as HTMLInputElement).checked;
    settings.accounts.forEach(syncSessionsForAccount);
    statusText = settings.proxyControlsEnabled ? "Proxies actives" : "Proxies desactives";
    render();
  });

  document.querySelector<HTMLSelectElement>("#proxySelect")?.addEventListener("change", (event) => {
    if (!proxyControlsEnabled()) return;
    const account = selectedAccount();
    if (!account) return;
    account.proxyId = (event.currentTarget as HTMLSelectElement).value || null;
    syncSessionsForAccount(account);
    statusText = "Proxy associe";
    render();
  });

  document.querySelector<HTMLInputElement>("#accountBypass")?.addEventListener("change", () => {
    if (!settings || !selectedAccount()) return;
    // Lit tout le formulaire (dont la case bypass) puis persiste tout de suite,
    // pour que le reglage par compte survive au rechargement.
    readSettingsForm();
    void invoke<AppSettings>("save_settings", { settings }).then((updated) => {
      settings = updated;
      statusText = selectedAccount()?.bypass
        ? "Bypass active pour ce compte"
        : "Bypass desactive pour ce compte";
      render();
    });
  });
};

const readSettingsForm = () => {
  if (!settings) return;
  const proxyControls = document.querySelector<HTMLInputElement>("#proxyControls");
  if (proxyControls) {
    settings.proxyControlsEnabled = proxyControls.checked;
  }

  const account = selectedAccount();
  const accountLabel = document.querySelector<HTMLInputElement>("#accountLabel");
  const accountHome = document.querySelector<HTMLInputElement>("#accountHome");
  const projectDir = document.querySelector<HTMLInputElement>("#projectDir");
  const proxySelect = document.querySelector<HTMLSelectElement>("#proxySelect");
  const accountBypass = document.querySelector<HTMLInputElement>("#accountBypass");

  if (account && (accountLabel || accountHome || projectDir || proxySelect || accountBypass)) {
    if (accountLabel) account.label = accountLabel.value.trim() || account.label;
    if (accountHome) account.codexHome = accountHome.value.trim() || account.codexHome;
    if (projectDir) account.projectDir = projectDir.value.trim() || null;
    if (settings.proxyControlsEnabled) {
      account.proxyId = proxySelect?.value || null;
    }
    if (accountBypass) account.bypass = accountBypass.checked;
    syncSessionsForAccount(account);
  }

  const shellInput = document.querySelector<HTMLInputElement>("#shellInput");
  const codexCommand = document.querySelector<HTMLInputElement>("#codexCommand");
  const autoRun = document.querySelector<HTMLInputElement>("#autoRun");
  const codexBypass = document.querySelector<HTMLInputElement>("#codexBypass");
  const autoDiscover = document.querySelector<HTMLInputElement>("#autoDiscover");
  if (shellInput) settings.shell = shellInput.value.trim() || settings.shell;
  if (codexCommand) settings.codexCommand = codexCommand.value.trim() || settings.codexCommand || "codex";
  if (autoRun) settings.autoRunCodex = autoRun.checked;
  if (codexBypass) settings.codexBypass = codexBypass.checked;
  if (autoDiscover) settings.autoDiscoverAccounts = autoDiscover.checked;
};

const createTerminalSession = (
  account: AccountProfile,
  proxy: ProxyProfile | null,
  agentId: string,
): TerminalSession => {
  const terminal = new Terminal({
    cursorBlink: true,
    cursorStyle: "bar",
    fontFamily: "Cascadia Mono, Consolas, monospace",
    fontSize: 13,
    lineHeight: 1.15,
    theme: {
      background: "#151513",
      foreground: "#e8e1d2",
      cursor: "#ffd166",
      selectionBackground: "#355f52",
      black: "#151513",
      red: "#f06f6c",
      green: "#8fd694",
      yellow: "#ffd166",
      blue: "#78a6d9",
      magenta: "#d29bd9",
      cyan: "#6ec6bd",
      white: "#e8e1d2",
      brightBlack: "#6f6a5d",
      brightRed: "#ff8a82",
      brightGreen: "#a7e9aa",
      brightYellow: "#ffe08a",
      brightBlue: "#94c1f0",
      brightMagenta: "#e7b3ef",
      brightCyan: "#8de1d7",
      brightWhite: "#fff8ea",
    },
  });
  const fitAddon = new FitAddon();
  terminal.loadAddon(fitAddon);

  const session: TerminalSession = {
    key: uid("terminal"),
    ptyId: null,
    accountId: account.id,
    agentId,
    title: account.label,
    projectDir: account.projectDir?.trim() || null,
    proxySummary: proxy ? maskProxy(proxy.proxyUrl) : "sans proxy",
    status: "Pret",
    running: false,
    startedAtUnix: null,
    codexSessionId: null,
    resumeSessionId: null,
    sessionCaptureDone: false,
    terminal,
    fitAddon,
  };

  terminal.onData((data) => {
    if (session.ptyId !== null) {
      void invoke("write_terminal", { id: session.ptyId, data }).catch(() => undefined);
    }
  });

  return session;
};

const mountActiveTerminal = () => {
  const host = document.querySelector<HTMLDivElement>("#terminal");
  if (!host) return;

  const session = activeTerminal();
  host.innerHTML = "";

  if (!session) {
    host.classList.add("empty-terminal");
    host.innerHTML = `<div class="terminal-placeholder">Ouvre un terminal avec le bouton +</div>`;
    return;
  }

  host.classList.remove("empty-terminal");

  if (session.terminal.element) {
    host.appendChild(session.terminal.element);
  } else {
    session.terminal.open(host);
  }

  queueMicrotask(() => {
    fitAndResizeActiveTerminal();
    session.terminal.focus();
  });
};

const createNewTerminal = async (
  accountId = selectedAccountId,
  settingsAlreadyRead = false,
  commandOverride: string | null = null,
  agentId: string | null = null,
  resumeSessionId: string | null = null,
) => {
  if (!settings) return;

  if (!settingsAlreadyRead) {
    readSettingsForm();
  }
  const account = settings.accounts.find((candidate) => candidate.id === accountId) ?? null;
  if (!account) return;

  const agents = settings.agents;
  const activeId = settings.activeAgentId ?? null;
  const chosenAgentId =
    (agentId && agents.some((agent) => agent.id === agentId) && agentId) ||
    (activeId && agents.some((agent) => agent.id === activeId) && activeId) ||
    agents[0]?.id ||
    "codex";

  selectedAccountId = account.id;
  settings.defaultAccountId = account.id;
  settings.activeAgentId = chosenAgentId;
  settings = await invoke<AppSettings>("save_settings", { settings });

  const savedAccount = settings.accounts.find((candidate) => candidate.id === account.id) ?? null;
  if (!savedAccount) return;

  const session = createTerminalSession(savedAccount, proxyForAccount(savedAccount), chosenAgentId);
  session.resumeSessionId = resumeSessionId;
  if (resumeSessionId) {
    session.codexSessionId = resumeSessionId;
    claimedSessionIds.add(resumeSessionId);
  }
  terminalSessions.push(session);
  activeTerminalKey = session.key;
  activeView = "terminal";
  stopLimitPoll();
  stopUsagePoll();
  stopDiscussionsPoll();
  stopRoomPoll();
  statusText = "Demarrage terminal";
  render();

  await startTerminalSession(session, commandOverride);
  persistTerminalSessions();
};

const startTerminalSession = async (session: TerminalSession, commandOverride: string | null = null) => {
  if (!settings) return;

  await waitForFrame();
  session.fitAddon.fit();

  const requestedId = reservePtyId();
  session.ptyId = requestedId;
  session.running = true;
  session.status = "Demarrage";
  session.startedAtUnix = Math.floor(Date.now() / 1000);
  statusText = "Demarrage terminal";
  render();

  const sessionAgent = agentById(session.agentId);
  const isIde = agentIsIde(sessionAgent);
  // Un agent IDE ne se tape pas dans le PTY : on ouvre l'editeur apres coup.
  const autoRunCommand =
    settings.autoRunCodex && !isIde
      ? agentRunCommand(sessionAgent, accountById(session.accountId))
      : null;

  try {
    // Workspace choisi (dossier de travail global) :
    //  - web  : envoye au serveur comme `workspacePath` (cwd = ce dossier ; le
    //           serveur ignore alors `repoUrl`) ;
    //  - desktop : envoye comme `projectDir` (override du dossier du compte).
    const workspace = currentWorkspace();
    const ptyId = await invoke<number>("start_terminal", {
      id: requestedId,
      accountId: session.accountId,
      repoUrl: isRemoteMode() ? session.projectDir ?? "" : undefined,
      workspacePath: isRemoteMode() ? workspace ?? undefined : undefined,
      projectDir: !isRemoteMode() ? workspace ?? undefined : undefined,
      branch: null,
      cols: session.terminal.cols,
      rows: session.terminal.rows,
      command: commandOverride ?? autoRunCommand,
      agentId: session.agentId,
    });
    session.ptyId = ptyId;
    session.running = true;
    session.status = "Actif";
    statusText = "Terminal actif";
    if (settings.autoRunCodex && isIde && sessionAgent && !commandOverride) {
      // Cohérent avec le terminal (cwd = workspace choisi) et avec le lancement
      // manuel : currentProjectDir() priorise le workspace, sinon le dossier du
      // terminal/compte. Sans ça, l'IDE s'ouvrirait sur le dossier du compte.
      void launchIde(sessionAgent, currentProjectDir());
    }
    persistTerminalSessions();
    const startedAccount = settings.accounts.find((candidate) => candidate.id === session.accountId) ?? null;
    const effectiveCommand = commandOverride ?? autoRunCommand ?? startedAccount?.startupCommand ?? null;
    if (session.resumeSessionId || (isCodexAgent(sessionAgent) && !isIde && !!effectiveCommand)) {
      void captureCodexSessionId(session);
    }
  } catch (error) {
    session.ptyId = null;
    session.running = false;
    session.status = "Erreur";
    statusText = String(error);
    session.terminal.writeln(`\r\n${String(error)}`);
  }

  render();
};

const closeTerminalSession = async (key: string) => {
  const index = terminalSessions.findIndex((session) => session.key === key);
  if (index === -1) return;

  const [session] = terminalSessions.splice(index, 1);
  const ptyId = session.ptyId;
  session.ptyId = null;
  session.running = false;
  session.terminal.dispose();

  if (activeTerminalKey === key) {
    activeTerminalKey = terminalSessions[Math.max(0, index - 1)]?.key ?? terminalSessions[0]?.key ?? null;
  }

  statusText = "Terminal ferme";
  render();
  persistTerminalSessions();

  if (ptyId !== null) {
    await invoke("stop_terminal", { id: ptyId }).catch(() => undefined);
  }
};

const sendLine = async (line: string) => {
  const session = activeTerminal();
  if (!session?.running || session.ptyId === null) return false;
  try {
    await invoke("write_terminal", { id: session.ptyId, data: `${line}\r` });
    return true;
  } catch (error) {
    statusText = String(error);
    render();
    return false;
  }
};

const escapeHtml = (value: string) =>
  value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");

const escapeAttr = escapeHtml;

const userHomeHint = () => (isRemoteMode() ? "%CST_DATA_DIR%\\codex-homes" : "%USERPROFILE%");

const setupEvents = async () => {
  unlistenData = await listen<PtyDataEvent>("pty-data", (event) => {
    const session = terminalSessions.find((candidate) => candidate.ptyId === event.payload.id);
    session?.terminal.write(event.payload.data);
  });

  unlistenExit = await listen<PtyExitEvent>("pty-exit", (event) => {
    const session = terminalSessions.find((candidate) => candidate.ptyId === event.payload.id);
    if (!session) return;

    session.ptyId = null;
    session.running = false;
    session.status = "Ferme";

    if (session.key === activeTerminalKey) {
      statusText = "Terminal ferme";
    }

    // Ne pas re-render tant que l'iframe Kombai tourne : un render() reconstruit
    // app.innerHTML et rechargerait l'editeur embarque (perte de l'etat). L'etat
    // terminal est deja a jour en memoire ; la sidebar se rafraichit au prochain
    // render (changement de vue, clic terminal...).
    if (!(activeView === "kombai" && (kombaiStatus?.running ?? false))) {
      render();
    }
    persistTerminalSessions();
  });

  window.addEventListener("resize", () => {
    fitAndResizeActiveTerminal();
  });

  window.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && agentsModalOpen) {
      event.preventDefault();
      closeAgentsModal();
      return;
    }

    if (event.key === "Escape" && newTerminalModalOpen) {
      event.preventDefault();
      closeNewTerminalModal();
      return;
    }

    if (event.key !== "F11") return;
    event.preventDefault();
    void toggleFullscreen();
  });
};

const renderRemoteLogin = (error: string | null = null) => {
  app.innerHTML = `
    <main class="remote-login">
      <section class="remote-login-panel">
        <div class="remote-login-head">
          <span><i data-lucide="server"></i></span>
          <div>
            <h1>Codex Switch Terminal</h1>
            <p>Connexion au serveur SaaS</p>
          </div>
        </div>
        ${error ? `<div class="remote-login-error">${escapeHtml(error)}</div>` : ""}
        <form id="remoteLoginForm" class="remote-login-form">
          <label>
            <span>Serveur</span>
            <input id="remoteBaseUrl" value="${escapeAttr(remoteBaseUrl())}" placeholder="http://IP_VM:8080" />
          </label>
          <label>
            <span>Token admin</span>
            <input id="remoteToken" type="password" autocomplete="current-password" />
          </label>
          <label>
            <span>Noeuds terminaux auto</span>
            <textarea id="remoteNodes" placeholder="PC fixe|http://100.x.x.x:8080||0&#10;Oracle free|http://100.y.y.y:8080||20">${escapeHtml(remoteNodesText())}</textarea>
          </label>
          <button class="tool-button primary" type="submit">
            <i data-lucide="badge-check"></i>
            <span>Se connecter</span>
          </button>
        </form>
      </section>
    </main>
  `;
  createIcons({ icons: lucideIcons });
  document.querySelector<HTMLFormElement>("#remoteLoginForm")?.addEventListener("submit", async (event) => {
    event.preventDefault();
    const baseUrl = document.querySelector<HTMLInputElement>("#remoteBaseUrl")?.value.trim() || remoteBaseUrl();
    const token = document.querySelector<HTMLInputElement>("#remoteToken")?.value.trim() || "";
    if (!token) {
      renderRemoteLogin("Token admin requis");
      return;
    }
    const nodes = document.querySelector<HTMLTextAreaElement>("#remoteNodes")?.value ?? "";
    saveRemoteConfig(baseUrl, token, nodes);
    await boot();
  });
};

const boot = async () => {
  await initializePlatform();
  void initDesktopUpdater();

  if (isRemoteMode() && !hasRemoteAuth()) {
    renderRemoteLogin();
    return;
  }

  try {
    settings = await invoke<AppSettings>("load_settings");
  } catch (error) {
    if (isRemoteMode()) {
      renderRemoteLogin(String(error));
      return;
    }
    throw error;
  }
  selectedAccountId = settings.defaultAccountId || settings.accounts[0]?.id || null;
  isFullscreen = await appWindow.isFullscreen().catch(() => false);
  await setupEvents();
  render();
  await restoreTerminals();
};

window.addEventListener("beforeunload", () => {
  persistTerminalSessions();
  unlistenData?.();
  unlistenExit?.();
  stopPoolPoll();
  stopLimitPoll();
  stopUsagePoll();
  stopKombaiPoll();
  stopDiscussionsPoll();
  // Best-effort : evite de laisser un code-server orphelin apres fermeture.
  void invoke("kombai_stop").catch(() => undefined);
  terminalSessions.forEach((session) => {
    if (session.ptyId !== null) {
      void invoke("stop_terminal", { id: session.ptyId }).catch(() => undefined);
    }
  });
});

void boot().catch((error) => {
  app.innerHTML = `<main class="boot error">${escapeHtml(String(error))}</main>`;
});
