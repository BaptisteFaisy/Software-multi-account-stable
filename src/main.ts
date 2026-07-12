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
  subscribeDiscussionUpdates,
  type DiscussionStreamMessage,
  type RealtimeConnectionState,
  type UnlistenFn,
} from "./platform";
import { initDesktopUpdater } from "./updater";
import { initPwaSupport } from "./pwa";
import {
  chatHoverShortcutAction,
  type ChatHoverShortcutAction,
} from "./chat/shortcuts";
import {
  chatSyncLabel,
  renderChatFeedInner,
  renderChatPanel,
  type ChatActivity,
  type ChatMode,
  type ChatMessage,
  type ChatPanelModel,
  type ChatQuotaSuggestion,
  type ChatSyncState,
  type ChatTurnStatus,
} from "./chat/view";
import { bestQuotaAccount, isQuotaExhaustionError } from "./chat/quota";
import {
  CHAT_SIDEBAR_DEFAULT_WIDTH,
  CHAT_SIDEBAR_MAX_WIDTH,
  CHAT_SIDEBAR_MIN_WIDTH,
  chatSidebarMaxWidth,
  clampChatSidebarWidth,
  defaultChatSidebarWidth,
} from "./chat/sidebar";
import {
  DEFAULT_EXPERT_CHAT_PAGE_SIZE,
  clampExpertChatPage,
  expertChatColumnCount,
  expertChatPageCount,
  expertChatPageForIndex,
  expertChatRowCount,
  expertChatsOnPage,
  normalizeExpertChatPageSize,
  type ExpertChatPageSize,
  type ExpertGridLayout,
} from "./chat/expert";
import {
  closeWorkspaceRegistry,
  draftEnvironmentChatPanes,
  isEphemeralChatWorkspacePath,
  mergeClosedWorkspaceIds,
  mergeWorkspaceProfiles,
  normalizeWorkspacePath,
  openWorkspaceRegistry,
  terminalsForFolder,
  userEnvironmentPath,
  workspaceBaseName,
  workspaceIdForPath,
  workspacePathBreadcrumbs,
  type WorkspaceProfile,
} from "./workspace";
import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import {
  AppWindow,
  ArrowLeft,
  BadgeCheck,
  BarChart3,
  Bot,
  CalendarClock,
  ChevronLeft,
  ChevronRight,
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
  Cpu,
  Gauge,
  MessagesSquare,
  Search,
  Send,
  ShieldCheck,
  Sparkles,
  ScanEye,
  FolderX,
  Library,
  ListChecks,
  Square,
  Wrench,
  Settings,
  Folder,
  FolderPlus,
  Folders,
  ChevronsUpDown,
  PanelLeftClose,
  PanelLeftOpen,
  createIcons,
} from "lucide";
import "@xterm/xterm/css/xterm.css";
import "./style.css";

type CodexReasoningEffort = string;

// Fournisseur CLI d'un compte / agent. Absent des configs anterieures => Codex.
type Provider = "codex" | "claude";

type AccountProfile = {
  id: string;
  label: string;
  // Fournisseur CLI de ce compte. Optionnel pour la retro-compat (defaut Codex).
  provider?: Provider;
  codexHome: string;
  projectDir?: string | null;
  proxyId?: string | null;
  startupCommand?: string | null;
  limits?: AccountLimitTracking;
  // Bypass Codex par compte (defaut ON). Absent des configs anterieures : on
  // retombe alors sur le defaut global `codexBypass`, puis `true`.
  bypass?: boolean;
  // Preferences Codex propres a ce CODEX_HOME. Optionnelles pour rester
  // compatible avec les settings.json crees avant leur introduction.
  model?: string | null;
  reasoningEffort?: CodexReasoningEffort | null;
};

const DEFAULT_CODEX_MODEL = "gpt-5.6-sol";
const DEFAULT_CODEX_REASONING_EFFORT: CodexReasoningEffort = "medium";
// Claude Code : alias de modele (pas d'intensite de raisonnement).
const DEFAULT_CLAUDE_MODEL = "sonnet";
const CLAUDE_MODEL_SUGGESTIONS = [
  "sonnet",
  "opus",
  "haiku",
  "claude-sonnet-4-5",
  "claude-opus-4-1",
];
const CODEX_MODEL_SUGGESTIONS = [
  "gpt-5.6-sol",
  "gpt-5.6-terra",
  "gpt-5.6-luna",
  "gpt-5.5",
  "gpt-5.4",
  "gpt-5.4-mini",
];
const CODEX_REASONING_EFFORTS: Array<{ value: CodexReasoningEffort; label: string }> = [
  { value: "minimal", label: "Minimale" },
  { value: "low", label: "Faible" },
  { value: "medium", label: "Moyenne" },
  { value: "high", label: "Elevee" },
  { value: "xhigh", label: "Tres elevee" },
  { value: "max", label: "Max" },
  { value: "ultra", label: "Ultra" },
];

type ModelReasoningEffortView = {
  reasoningEffort: string;
  description?: string | null;
};

type AccountModelView = {
  id: string;
  displayName: string;
  defaultReasoningEffort?: string | null;
  supportedReasoningEfforts: ModelReasoningEffortView[];
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
  provider?: Provider;
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
  // Registre synchronise des workspaces (dossiers projets ouverts). Optionnel
  // pour la retro-compat : un settings.json anterieur ne le porte pas encore.
  // Le workspace ACTIF reste local a l'appareil (WORKSPACE_STORAGE_KEY) : seule
  // la LISTE se synchronise entre appareils.
  workspaces?: WorkspaceProfile[];
  // Tombstones synchronises : une ancienne discussion ne doit pas rouvrir un
  // workspace que l'utilisateur a explicitement ferme.
  closedWorkspaceIds?: string[];
};

type RoomAgent = {
  ident: string;
  agentId: string;
  accountId: string;
  label: string;
  cwd?: string | null;
  workspaceId?: string | null;
  present: boolean;
  joinedAt: number;
  lastSeen: number;
};

type RoomMerge = {
  id: number;
  status: "queued" | "running" | "landed" | "conflict" | "verifyFailed" | "failed";
  agentIdent: string;
  targetRef: string;
  landedSha?: string | null;
};

type RoomTask = {
  id: string;
  description: string;
  status: "claimed" | "completed";
  claimedBy: string;
};

type RoomMessage = {
  id: number;
  ts: number;
  roomId: string;
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
    roomId: string;
    agents: RoomAgent[];
    present: number;
    totalMessages: number;
    cursor: number;
    oldestCursor: number;
    coordination: {
      queued: number;
      running: number;
      landed: number;
      attention: number;
      recentLanded: RoomMerge[];
      tasks: RoomTask[];
    };
    storeOwner: boolean;
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

type TerminalStartResponse = {
  id: number;
  workspaceId: string;
  workspacePath: string;
  roomId?: string;
};

type TerminalSession = {
  key: string;
  ptyId: number | null;
  accountId: string;
  agentId: string;
  title: string;
  // Dossier logique choisi par l'utilisateur. Plusieurs agents/terminaux
  // partagent ce dossier tout en travaillant dans des workspaces physiques
  // differents, crees par le gestionnaire de worktrees.
  folderPath: string | null;
  workspaceId: string | null;
  workspacePath: string | null;
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
  folderPath?: string | null;
  workspaceId?: string | null;
  workspacePath?: string | null;
  projectDir?: string | null;
};

type PersistedTerminalState = {
  v: 4;
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
  | "room"
  | "audit"
  | "skills"
  | "settings"
  | "chat";

type DiscussionSummary = {
  // Identite LOGIQUE de la conversation (stable a travers les reprises/forks).
  // Sert de cle de regroupement et de suppression.
  sessionId: string;
  // Identite du fichier rollout HEAD (le plus recent). Cible de `codex resume`
  // et de la copie vers un autre compte.
  rolloutId: string;
  // Nombre de fichiers rollout regroupes sous ce sessionId (>1 = repris).
  forkCount: number;
  // Fournisseur d'origine (codex/claude) : badge + routage de la continuation.
  provider?: Provider;
  accountId: string;
  accountLabel: string;
  codexHome: string;
  filePath: string;
  // Dossier logique restaure par l'UI. Le backend persiste ensuite cette
  // valeur dans `cwd`, qui peut initialement viser un worktree ephemere.
  folderPath?: string | null;
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
  provider?: Provider;
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

// Transcript structure d'une discussion pour la vue conversation (bulles).
type DiscussionTranscriptView = {
  sessionId: string;
  messages: ChatMessage[];
  truncated: boolean;
};

type ChatTurnSnapshot = {
  id: number;
  accountId: string;
  sessionId?: string | null;
  status: Exclude<ChatTurnStatus, "idle">;
  startedAt: number;
  finishedAt?: number | null;
  error?: string | null;
  activities: ChatActivity[];
};

type ExpertChatPane = {
  key: string;
  discussion: DiscussionSummary | null;
  messages: ChatMessage[];
  loading: boolean;
  error: string | null;
  truncated: boolean;
  syncState: ChatSyncState;
  liveUnlisten: UnlistenFn | null;
  fallbackPoll: number | null;
  loadInFlight: boolean;
  turn: ChatTurnSnapshot | null;
  turnPoll: number | null;
  turnPollInFlight: boolean;
  draft: string;
  mode: ChatMode;
  accountId: string | null;
  historyOpen: boolean;
  pendingWorkspace: string | null;
  followLatest: boolean;
  scrollTop: number;
};

type PersistedExpertChatPane = {
  key: string;
  sessionId: string | null;
  accountId: string | null;
  draft: string;
  mode: ChatMode;
  pendingWorkspace: string | null;
};

type PersistedExpertChats = {
  v: 1;
  activeKey: string | null;
  panes: PersistedExpertChatPane[];
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

type PromptSessionHistory = {
  key: string;
  sessionId: string;
  accountId: string;
  accountLabel: string;
  cwd: string | null;
  sessionTitle: string | null;
  firstTimestamp: number;
  lastTimestamp: number;
  prompts: PromptEntry[];
};

const app = document.querySelector<HTMLDivElement>("#app");

if (!app) {
  throw new Error("Missing #app");
}

// Event Horizon : fond « trou noir » (disque d'accretion + singularite +
// vignette) injecte une seule fois, hors de #app, pour survivre aux re-render
// et laisser l'animation tourner sans interruption. Respecte prefers-reduced-motion
// via la CSS (.eh-accretion). aria-hidden : purement decoratif.
function ensureEventHorizonBackground(): void {
  if (typeof document === "undefined" || !document.body) return;
  if (document.querySelector(".eh-bg")) return;
  const bg = document.createElement("div");
  bg.className = "eh-bg";
  bg.setAttribute("aria-hidden", "true");
  bg.innerHTML =
    '<div class="eh-accretion"></div><div class="eh-singularity"></div><div class="eh-vignette"></div>';
  document.body.prepend(bg);
}

ensureEventHorizonBackground();

let settings: AppSettings | null = null;
let selectedAccountId: string | null = null;
let activeTerminalKey: string | null = null;
let lastPointerClientX: number | null = null;
let lastPointerClientY: number | null = null;
let expertTerminalFullscreenKey: string | null = null;
let statusText = "Pret";
let ptyIdSeed = Date.now();
let terminalSessions: TerminalSession[] = [];
// Dossier dont la session est actuellement ouverte. `null` signifie qu'aucun
// environnement n'a encore ete choisi : on affiche alors le sas de selection,
// jamais les terminaux de plusieurs projets dans un meme mur.
let terminalFolderFilter: string | null = null;
// Creations de terminaux en vol (pas encore poussees dans terminalSessions) :
// permet de faire respecter la limite EXPERT_MAX_TERMINALS malgre les await
// (deux creations concurrentes ne peuvent plus reserver le meme dernier slot).
let pendingTerminalCreations = 0;
// Terminal qui detenait le focus juste avant le dernier render() (capture avant
// la destruction du DOM) : restaure de facon synchrone au remontage pour ne pas
// perdre les frappes lors d'un re-render incident (ex: sortie d'un PTY voisin).
let focusedTerminalKeyBeforeRender: string | null = null;
// Terminal a focaliser volontairement au prochain montage (nouveau terminal,
// selection dans la liste, affichage du mur de terminaux).
let requestTerminalFocusKey: string | null = null;
let globalMobileListenersBound = false;
let mobileRefitTimer = 0;
let unlistenData: UnlistenFn | null = null;
let unlistenExit: UnlistenFn | null = null;
let activeView: AppView = "chat";
let expertGridLayout: ExpertGridLayout = "auto";
let expertChatsPerPage: ExpertChatPageSize = DEFAULT_EXPERT_CHAT_PAGE_SIZE;
let expertChatPage = 0;
let terminalRestoreAttempted = false;
let terminalRestorePromise: Promise<void> | null = null;
let poolStatus: PoolStatus | null = null;
let poolPoll: number | null = null;
let poolImportPaths = "";
let poolNewAccountLabel = "";
let poolNewAccountProxyId = "";
let poolNewAccountBypass = true;
let poolNewAccountModel = DEFAULT_CODEX_MODEL;
let poolNewAccountReasoningEffort: CodexReasoningEffort = DEFAULT_CODEX_REASONING_EFFORT;
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
let newTerminalWorkspacePath: string | null = null;
let newTerminalAccountLabel = "";
let newTerminalAccountProvider: Provider = "codex";
let newTerminalAccountBypass = true;
let newTerminalAccountModel = DEFAULT_CODEX_MODEL;
let newTerminalAccountReasoningEffort: CodexReasoningEffort = DEFAULT_CODEX_REASONING_EFFORT;
// Fenetre "nouveau chat" : on choisit le compte, le modele et le mode avant
// d'ouvrir reellement le pane (tous les points d'entree "nouveau chat" y passent).
let newChatModalOpen = false;
let newChatAccountId: string | null = null;
let newChatMode: ChatMode = "build";
let newChatModel = "";
let newChatPendingWorkspace: string | null = null;
let agentsModalOpen = false;
let discussions: DiscussionsView | null = null;
let discussionsLoaded = false;
let discussionsPoll: number | null = null;
let discussionsLiveUnlisten: UnlistenFn | null = null;
let discussionsSyncState: RealtimeConnectionState = "closed";
let discussionSearch = "";
let chatSidebarSearch = "";
let chatSidebarWidth = CHAT_SIDEBAR_DEFAULT_WIDTH;
// Compte cible choisi par discussion (sessionId -> accountId). Defaut : le
// compte d'origine. Persiste entre les re-rendus (poll 60s) pour ne pas perdre
// le choix en cours.
const discussionTargetSel = new Map<string, string>();
let discussionBusyId: string | null = null;
const CHAT_DRAG_MIME = "application/x-cst-chat";
let draggedChatSessionId: string | null = null;
// Vue conversation : discussion ouverte en bulles + son transcript charge.
let chatDiscussion: DiscussionSummary | null = null;
let chatMessages: ChatMessage[] = [];
let chatLoading = false;
let chatError: string | null = null;
let chatTruncated = false;
let chatSyncState: ChatSyncState = "closed";
let chatLiveUnlisten: UnlistenFn | null = null;
let chatFallbackPoll: number | null = null;
let chatLoadInFlight = false;
let chatTurn: ChatTurnSnapshot | null = null;
let chatTurnPoll: number | null = null;
let chatTurnPollInFlight = false;
let chatDraft = "";
let chatMode: ChatMode = "build";
let chatAccountId: string | null = null;
let chatHistoryOpen = false;
// Le fil est mis a jour plusieurs fois par seconde pendant une reponse. Garder
// l'intention de suivi en memoire evite de ramener de force au bas un utilisateur
// qui vient juste de commencer a remonter avec la molette ou au tactile.
const CHAT_SCROLL_BOTTOM_EPSILON = 12;
let chatFollowLatest = true;
let chatScrollTop = 0;
let skipNextChatScrollCapture = false;
let chatPreferencesSave: Promise<void> = Promise.resolve();
const chatModelCatalogs = new Map<string, AccountModelView[]>();
const chatModelCatalogLoads = new Set<string>();
let expertChatPanes: ExpertChatPane[] = [];
let activeExpertChatKey: string | null = null;
let expertChatFullscreenKey: string | null = null;
let expertChatsRestored = false;
let promptHistory: PromptHistoryView | null = null;
let promptHistoryLoaded = false;
let promptSearch = "";
let roomStatus: RoomStatus | null = null;
let roomMessages: RoomMessage[] = [];
let roomPoll: number | null = null;
let workspaceLiveGraphOpen = false;
// Destinataire choisi dans le composer : "" = diffusion workspace, sinon ident d'un
// agent (DM). Conserve entre les rendus complets.
let roomComposeTarget = "";
// Selecteur de workspace (mode web) : modale de navigation de dossiers serveur.
type WorkspacePickerTarget = "active" | "new-terminal";
let workspaceModalOpen = false;
let workspacePickerTarget: WorkspacePickerTarget = "active";
let workspaceBrowse: FsListResponse | null = null;
let workspaceBrowseLoading = false;
let workspaceBrowseError = "";
let terminalEnvironmentMenuOpen = false;

// --- Audit design (détecteur Impeccable) -----------------------------------
// Un finding = un anti-pattern détecté sur un élément de la page courante.
type AuditFinding = {
  type: string;
  category: string;
  severity: string;
  detail: string;
  name: string;
  description: string;
  selector: string;
  tagName: string;
};

// Résultats du dernier audit (null tant qu'aucun audit n'a été lancé).
let auditFindings: AuditFinding[] | null = null;
let auditLoading = false;
let auditError: string | null = null;
// Libellé de la vue auditée (affiché dans l'en-tête du rapport).
let auditViewLabel: string | null = null;
// Chargement mémoïsé du bundle détecteur (injecté à la demande, une seule fois).
let impeccableLoadPromise: Promise<void> | null = null;

// --- Bibliothèque de skills (fichiers embarqués, indépendants d'AgentsRoom) --
type SkillEntry = {
  id: string;
  name: string;
  description: string;
  tags: string[];
  content: string;
};
let skillsList: SkillEntry[] | null = null;
let skillsLoaded = false;
let skillsError: string | null = null;

const lucideIcons = {
  AppWindow,
  ArrowLeft,
  BadgeCheck,
  BarChart3,
  Bot,
  CalendarClock,
  ChevronLeft,
  ChevronRight,
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
  Cpu,
  Gauge,
  MessagesSquare,
  Search,
  Send,
  ShieldCheck,
  Sparkles,
  ScanEye,
  FolderX,
  Library,
  ListChecks,
  Square,
  Wrench,
  Settings,
  Folder,
  FolderPlus,
  Folders,
  ChevronsUpDown,
  PanelLeftClose,
  PanelLeftOpen,
};

const OPEN_TERMINALS_STORAGE_KEY = "codex-switch-terminal.open-terminals.v4";
const LEGACY_OPEN_TERMINALS_STORAGE_KEYS = [
  "codex-switch-terminal.open-terminals.v3",
  "codex-switch-terminal.open-terminals.v2",
] as const;
const EXPERT_GRID_LAYOUT_STORAGE_KEY = "codex-switch-terminal.expert-grid-layout.v1";
const EXPERT_CHATS_PER_PAGE_STORAGE_KEY = "codex-switch-terminal.expert-chats-per-page.v1";
const EXPERT_MAX_TERMINALS = 16;
const EXPERT_OPEN_CHATS_STORAGE_KEY = "codex-switch-terminal.expert-open-chats.v1";
const CHAT_SIDEBAR_WIDTH_STORAGE_KEY = "codex-switch-terminal.chat-sidebar-width.v1";
const CHAT_SIDEBAR_SNAP_CLOSED_WIDTH = 48;
const LIMIT_POLL_INTERVAL_MS = 30_000;

const loadExpertGridLayout = (): ExpertGridLayout => {
  const value = localStorage.getItem(EXPERT_GRID_LAYOUT_STORAGE_KEY);
  return value === "2" || value === "3" || value === "4" ? value : "auto";
};

const loadExpertChatsPerPage = (): ExpertChatPageSize =>
  normalizeExpertChatPageSize(localStorage.getItem(EXPERT_CHATS_PER_PAGE_STORAGE_KEY));

const loadChatSidebarWidth = (): number => {
  const stored = localStorage.getItem(CHAT_SIDEBAR_WIDTH_STORAGE_KEY);
  if (stored === null) return defaultChatSidebarWidth(window.innerWidth);
  const parsed = Number(stored);
  if (!Number.isFinite(parsed)) return defaultChatSidebarWidth(window.innerWidth);
  return Math.max(
    CHAT_SIDEBAR_MIN_WIDTH,
    Math.min(CHAT_SIDEBAR_MAX_WIDTH, Math.round(parsed)),
  );
};

const displayedChatSidebarWidth = (): number =>
  clampChatSidebarWidth(chatSidebarWidth, window.innerWidth);

const syncChatSidebarWidthDom = () => {
  const layout = document.querySelector<HTMLElement>(".chat-app-layout");
  const resizer = document.querySelector<HTMLElement>("#chatSidebarResizer");
  if (!layout || !resizer) return;
  const width = displayedChatSidebarWidth();
  layout.style.setProperty("--chat-sidebar-width", `${width}px`);
  layout.classList.toggle("is-sidebar-collapsed", width === 0);
  resizer.setAttribute("aria-valuenow", String(width));
  resizer.setAttribute("aria-valuemax", String(chatSidebarMaxWidth(window.innerWidth)));
  resizer.setAttribute("aria-valuetext", width === 0 ? "Colonne masquée" : `${width} pixels`);
};

const setChatSidebarWidth = (width: number, persist = true) => {
  chatSidebarWidth = clampChatSidebarWidth(width, window.innerWidth);
  syncChatSidebarWidthDom();
  if (persist) {
    localStorage.setItem(CHAT_SIDEBAR_WIDTH_STORAGE_KEY, String(chatSidebarWidth));
  }
};

const bindChatSidebarResizer = () => {
  const resizer = document.querySelector<HTMLElement>("#chatSidebarResizer");
  if (!resizer) return;

  let pointerId: number | null = null;
  let pointerStartX = 0;
  let widthAtPointerStart = 0;

  const finishResize = (event: PointerEvent) => {
    if (pointerId !== event.pointerId) return;
    const capturedPointerId = pointerId;
    pointerId = null;
    document.body.classList.remove("chat-sidebar-resizing");
    if (displayedChatSidebarWidth() <= CHAT_SIDEBAR_SNAP_CLOSED_WIDTH) {
      setChatSidebarWidth(0);
    } else {
      localStorage.setItem(CHAT_SIDEBAR_WIDTH_STORAGE_KEY, String(chatSidebarWidth));
    }
    if (resizer.hasPointerCapture(capturedPointerId)) {
      resizer.releasePointerCapture(capturedPointerId);
    }
    fitAndResizeVisibleTerminals();
  };

  resizer.addEventListener("pointerdown", (event) => {
    if (!event.isPrimary || event.button !== 0) return;
    event.preventDefault();
    pointerId = event.pointerId;
    pointerStartX = event.clientX;
    widthAtPointerStart = displayedChatSidebarWidth();
    resizer.setPointerCapture(event.pointerId);
    document.body.classList.add("chat-sidebar-resizing");
  });
  resizer.addEventListener("pointermove", (event) => {
    if (pointerId !== event.pointerId) return;
    setChatSidebarWidth(widthAtPointerStart + event.clientX - pointerStartX, false);
  });
  resizer.addEventListener("pointerup", finishResize);
  resizer.addEventListener("pointercancel", finishResize);
  resizer.addEventListener("lostpointercapture", finishResize);
  resizer.addEventListener("dblclick", () => {
    setChatSidebarWidth(defaultChatSidebarWidth(window.innerWidth));
    fitAndResizeVisibleTerminals();
  });
  resizer.addEventListener("keydown", (event) => {
    const step = event.shiftKey ? 32 : 16;
    let nextWidth: number | null = null;
    if (event.key === "ArrowLeft") nextWidth = displayedChatSidebarWidth() - step;
    if (event.key === "ArrowRight") nextWidth = displayedChatSidebarWidth() + step;
    if (event.key === "Home") nextWidth = CHAT_SIDEBAR_MIN_WIDTH;
    if (event.key === "End") nextWidth = chatSidebarMaxWidth(window.innerWidth);
    if (nextWidth === null) return;
    event.preventDefault();
    setChatSidebarWidth(nextWidth);
    fitAndResizeVisibleTerminals();
  });
};

// Workspace actif = valeur proposee aux PROCHAINS terminaux. Chaque session en
// capture ensuite une copie immuable. Memorise par appareil (localStorage) : en
// web c'est un dossier du serveur ; en desktop un dossier local.
const WORKSPACE_STORAGE_KEY = "codex-switch-terminal.workspace.path";
const WORKSPACES_STORAGE_KEY = "codex-switch-terminal.workspaces.v1";

const loadWorkspacePaths = (): string[] => {
  try {
    const parsed = JSON.parse(localStorage.getItem(WORKSPACES_STORAGE_KEY) ?? "[]");
    if (!Array.isArray(parsed)) return [];
    const seen = new Set<string>();
    const sanitized = parsed
      .filter((path): path is string => typeof path === "string" && path.trim().length > 0)
      .map((path) => userEnvironmentPath(path))
      .filter((path): path is string => !!path)
      .filter((path) => {
        const key = normalizeWorkspacePath(path);
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });
    if (JSON.stringify(parsed) !== JSON.stringify(sanitized)) {
      localStorage.setItem(WORKSPACES_STORAGE_KEY, JSON.stringify(sanitized));
    }
    return sanitized;
  } catch {
    return [];
  }
};

const storeWorkspacePaths = (paths: readonly string[]) => {
  localStorage.setItem(WORKSPACES_STORAGE_KEY, JSON.stringify(paths));
};

const rememberWorkspace = (path: string) => {
  const trimmed = userEnvironmentPath(path);
  if (!trimmed) return;
  const key = normalizeWorkspacePath(trimmed);
  const paths = loadWorkspacePaths().filter((item) => normalizeWorkspacePath(item) !== key);
  storeWorkspacePaths([trimmed, ...paths].slice(0, 12));
};

const forgetWorkspace = (path: string) => {
  const id = workspaceIdForPath(path);
  storeWorkspacePaths(
    loadWorkspacePaths().filter((item) => workspaceIdForPath(item) !== id),
  );
};

const currentWorkspace = (): string | null => {
  const stored = localStorage.getItem(WORKSPACE_STORAGE_KEY);
  const environment = userEnvironmentPath(stored);
  if (stored?.trim() && !environment) localStorage.removeItem(WORKSPACE_STORAGE_KEY);
  return environment;
};

const setCurrentWorkspace = (path: string | null) => {
  const trimmed = userEnvironmentPath(path);
  if (trimmed) {
    rememberWorkspace(trimmed);
    localStorage.setItem(WORKSPACE_STORAGE_KEY, trimmed);
  } else {
    localStorage.removeItem(WORKSPACE_STORAGE_KEY);
  }
};

// --- Workspaces (dossiers projets, contexte des chats) ---------------------
// Un workspace regroupe les chats faits dans un meme dossier. L'appartenance
// d'un chat est DERIVEE du cwd de sa discussion (aucune reference stockee). Le
// registre synchronise vit dans settings.workspaces (backend) ; la selection
// locale indique le workspace cible sans masquer les autres groupes.
const WORKSPACE_ALL = "__all__";
const WORKSPACE_UNKNOWN = "__unknown__";
const CHAT_WS_FILTER_KEY = "codex-switch-terminal.chat-workspace-filter";

const chatWorkspaceFilterRaw = (): string | null =>
  localStorage.getItem(CHAT_WS_FILTER_KEY);
const activeChatWorkspaceFilter = (): string => {
  const stored = chatWorkspaceFilterRaw();
  if (stored && isEphemeralChatWorkspacePath(stored)) {
    localStorage.setItem(CHAT_WS_FILTER_KEY, WORKSPACE_ALL);
    return WORKSPACE_ALL;
  }
  return stored || WORKSPACE_ALL;
};
const setChatWorkspaceFilter = (value: string) => {
  localStorage.setItem(CHAT_WS_FILTER_KEY, value);
};

// Workspace lie a un NOUVEAU chat (capture-a-la-creation) : garantit que le
// dossier d'un chat cree dans le workspace X reste X meme si l'utilisateur
// change de workspace avant d'envoyer le premier message.
let pendingChatWorkspace: string | null = null;
let workspaceClosingId: string | null = null;

const closedWorkspaceIds = (): Set<string> =>
  new Set(mergeClosedWorkspaceIds(settings?.closedWorkspaceIds ?? []));

const workspaceIsClosed = (path: string): boolean =>
  closedWorkspaceIds().has(workspaceIdForPath(path));

// Un transcript enregistre le cwd physique de l'agent. Tant que l'association
// terminal est connue (y compris apres restauration v4), on le rattache au
// Dossier logique au lieu de creer un faux Dossier par worktree.
const folderPathForRuntimePath = (rawPath: string | null | undefined): string | null => {
  const path = rawPath?.trim();
  if (!path) return null;
  const linkedTerminal = terminalSessions.find(
    (session) =>
      session.workspacePath &&
      normalizeWorkspacePath(session.workspacePath) === normalizeWorkspacePath(path),
  );
  return userEnvironmentPath(linkedTerminal?.folderPath) ?? userEnvironmentPath(path);
};

const discussionFolderPath = (
  discussion: DiscussionSummary | null | undefined,
): string | null =>
  userEnvironmentPath(discussion?.folderPath) ?? folderPathForRuntimePath(discussion?.cwd);

// Une reouverture explicite restaure aussi le contexte global du dossier : la
// room, le mur de terminaux et les prochains messages pointent tous au meme
// dossier logique, jamais au worktree physique de l'ancien agent.
const activateDiscussionFolder = (discussion: DiscussionSummary): string | null => {
  const folderPath = discussionFolderPath(discussion);
  if (!folderPath) return null;
  discussion.folderPath = folderPath;
  setCurrentWorkspace(folderPath);
  setChatWorkspaceFilter(workspaceIdForPath(folderPath));
  terminalFolderFilter = folderPath;
  void upsertWorkspaceRegistry(folderPath);
  return folderPath;
};

// Enumeration des workspaces connus : union du registre synchronise, du MRU
// local, du workspace actif, et des cwd distincts des discussions. Trie : actif
// d'abord, puis par activite la plus recente, puis alphabetique.
const knownWorkspaces = (): WorkspaceProfile[] => {
  const byId = new Map<string, WorkspaceProfile>();
  const closedIds = closedWorkspaceIds();
  const add = (rawPath: string | null | undefined) => {
    const path = userEnvironmentPath(rawPath);
    if (!path) return;
    const id = workspaceIdForPath(path);
    if (closedIds.has(id)) return;
    if (!byId.has(id)) byId.set(id, { id, label: workspaceBaseName(path), path });
  };

  mergeWorkspaceProfiles(settings?.workspaces ?? []).workspaces.forEach((ws) => {
    if (closedIds.has(ws.id)) return;
    if (!byId.has(ws.id)) byId.set(ws.id, ws);
  });
  add(currentWorkspace());
  loadWorkspacePaths().forEach(add);
  terminalSessions.forEach((session) => add(session.folderPath));
  allDiscussions().forEach((discussion) => add(discussionFolderPath(discussion)));

  const lastActivity = new Map<string, number>();
  allDiscussions().forEach((discussion) => {
    const folderPath = discussionFolderPath(discussion);
    if (!folderPath) return;
    const id = workspaceIdForPath(folderPath);
    lastActivity.set(id, Math.max(lastActivity.get(id) ?? 0, discussion.lastActivity));
  });

  const active = currentWorkspace();
  const activeId = active ? workspaceIdForPath(active) : null;
  return [...byId.values()].sort((left, right) => {
    if (left.id === activeId) return -1;
    if (right.id === activeId) return 1;
    const delta = (lastActivity.get(right.id) ?? 0) - (lastActivity.get(left.id) ?? 0);
    if (delta !== 0) return delta;
    return left.label.localeCompare(right.label);
  });
};

// Ajoute un dossier au registre synchronise s'il en est absent, puis persiste.
const upsertWorkspaceRegistry = async (path: string): Promise<void> => {
  if (!settings) return;
  const trimmed = userEnvironmentPath(path);
  if (!trimmed) return;
  rememberWorkspace(trimmed);
  const update = openWorkspaceRegistry(
    settings.workspaces ?? [],
    settings.closedWorkspaceIds ?? [],
    trimmed,
  );
  if (!update.changed) return;
  settings.workspaces = update.workspaces;
  settings.closedWorkspaceIds = update.closedWorkspaceIds;
  try {
    settings = await invoke<AppSettings>("save_settings", { settings });
  } catch (error) {
    statusText = String(error);
  }
};

// Migration au demarrage : peuple le registre synchronise depuis le MRU + le
// workspace actif locaux (utilisateurs existants), miroir le registre dans le
// MRU local (nouvel appareil), puis fixe un filtre par defaut pour cet appareil.
const syncWorkspaceRegistry = async (): Promise<void> => {
  if (!settings) return;
  const storedClosedIds = settings.closedWorkspaceIds ?? [];
  const normalizedClosedIds = mergeClosedWorkspaceIds(storedClosedIds);
  const closedIds = new Set(normalizedClosedIds);
  const merged = mergeWorkspaceProfiles(settings.workspaces ?? []);
  const openProfiles = merged.workspaces.filter((workspace) => !closedIds.has(workspace.id));
  const byId = new Map<string, WorkspaceProfile>(
    openProfiles.map((ws) => [ws.id, ws]),
  );
  let changed =
    merged.changed ||
    openProfiles.length !== merged.workspaces.length ||
    normalizedClosedIds.length !== storedClosedIds.length ||
    normalizedClosedIds.some(
      (closedId, index) => closedId !== storedClosedIds[index],
    );

  settings.closedWorkspaceIds = normalizedClosedIds;

  const rememberedPaths = loadWorkspacePaths();
  const openRememberedPaths = rememberedPaths.filter(
    (path) => !closedIds.has(workspaceIdForPath(path)),
  );
  if (openRememberedPaths.length !== rememberedPaths.length) {
    storeWorkspacePaths(openRememberedPaths);
  }
  const activePath = currentWorkspace();
  if (activePath && closedIds.has(workspaceIdForPath(activePath))) {
    setCurrentWorkspace(null);
    setChatWorkspaceFilter(WORKSPACE_ALL);
  }

  const seed = (rawPath: string | null | undefined) => {
    const path = rawPath?.trim();
    if (!path) return;
    const id = workspaceIdForPath(path);
    if (closedIds.has(id)) return;
    if (!byId.has(id)) {
      byId.set(id, { id, label: workspaceBaseName(path), path });
      changed = true;
    }
  };
  seed(currentWorkspace());
  openRememberedPaths.forEach(seed);

  // Miroir inverse : rend les workspaces synchronises visibles sur cet appareil.
  byId.forEach((ws) => rememberWorkspace(ws.path));

  if (changed) {
    settings.workspaces = [...byId.values()];
    try {
      settings = await invoke<AppSettings>("save_settings", { settings });
    } catch {
      // best-effort : la migration retentera au prochain demarrage.
    }
  }

  // Valeur de compatibilite pour les utilisateurs existants. La barre laterale
  // affiche desormais tous les groupes, quelle que soit cette selection.
  if (chatWorkspaceFilterRaw() === null) {
    setChatWorkspaceFilter(WORKSPACE_ALL);
  }
};

const uid = (prefix: string) =>
  `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;

const EMPTY_TERMINAL_STATE: PersistedTerminalState = { v: 4, activeKey: null, terminals: [] };

const loadOpenTerminalRecords = (): PersistedTerminalState => {
  try {
    const raw =
      localStorage.getItem(OPEN_TERMINALS_STORAGE_KEY) ??
      LEGACY_OPEN_TERMINALS_STORAGE_KEYS
        .map((key) => localStorage.getItem(key))
        .find((value): value is string => value !== null);
    if (!raw) return { ...EMPTY_TERMINAL_STATE };
    const parsed = JSON.parse(raw);
    if (!parsed || !Array.isArray(parsed.terminals)) return { ...EMPTY_TERMINAL_STATE };
    const legacyWorkspaceWasFolder = Number(parsed.v ?? 3) < 4;

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
          folderPath:
            typeof item.folderPath === "string"
              ? item.folderPath
              : legacyWorkspaceWasFolder && typeof item.workspacePath === "string"
                ? item.workspacePath
                : null,
          workspaceId: typeof item.workspaceId === "string" ? item.workspaceId : null,
          workspacePath:
            !legacyWorkspaceWasFolder && typeof item.workspacePath === "string"
              ? item.workspacePath
              : null,
          projectDir: typeof item.projectDir === "string" ? item.projectDir : null,
        };
      })
      .filter((item: PersistedTerminalRecord | null): item is PersistedTerminalRecord => item !== null);

    return {
      v: 4,
      activeKey: typeof parsed.activeKey === "string" ? parsed.activeKey : null,
      terminals,
    };
  } catch {
    return { ...EMPTY_TERMINAL_STATE };
  }
};

const saveOpenTerminalRecords = (state: PersistedTerminalState) => {
  localStorage.setItem(OPEN_TERMINALS_STORAGE_KEY, JSON.stringify(state));
  LEGACY_OPEN_TERMINALS_STORAGE_KEYS.forEach((key) => localStorage.removeItem(key));
};

const persistTerminalSessions = () => {
  // Les PTY sont charges paresseusement. Ne jamais ecraser leur etat persiste
  // par une liste vide tant que le mur de terminaux n'a pas ete ouvert.
  if (!terminalRestoreAttempted && terminalSessions.length === 0) return;
  saveOpenTerminalRecords({
    v: 4,
    activeKey: activeTerminalKey,
    terminals: terminalSessions
      .filter((session) => session.status !== "Ferme")
      .map((session) => ({
        key: session.key,
        accountId: session.accountId,
        agentId: session.agentId,
        codexSessionId: session.codexSessionId,
        folderPath: session.folderPath,
        workspaceId: session.workspaceId,
        workspacePath: session.workspacePath,
        projectDir: session.projectDir,
      })),
  });
};

// --- Reprise des discussions Codex ---------------------------------------
// Un rollout Codex = une discussion (rollout-<ts>-<uuid>.jsonl). On garde
// l'uuid (session id) pour relancer `codex resume <uuid>` a la reouverture.
const UUID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
const isPlausibleSessionId = (id: string | null | undefined): id is string => !!id && UUID_RE.test(id);

// Commande de reprise d'une discussion, selon le provider du compte cible :
// Codex -> `codex … resume <id>` ; Claude -> `claude … --resume <id>`. Le flag
// bypass (propre au provider) est ajoute par `agentRunCommand`.
const buildResumeCommand = (id: string, account: AccountProfile | null | undefined = null) => {
  const provider = accountProvider(account);
  const base = agentRunCommand(agentById(providerAgentId(provider)), account);
  return provider === "claude" ? `${base} --resume ${id}` : `${base} resume ${id}`;
};

// Une reprise interactive restaure seulement le contexte puis attend une
// saisie. Lors d'un deplacement explicite, ce premier message fait repartir
// l'agent sans demander a l'utilisateur de taper « continue ».
const buildResumeAndContinueCommand = (
  id: string,
  account: AccountProfile | null | undefined = null,
) => `${buildResumeCommand(id, account)} continue`;

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

// --- Multi-provider (Codex / Claude Code) --------------------------------
// Provider d'un compte / d'un agent (defaut Codex pour les configs anterieures).
const accountProvider = (account: AccountProfile | null | undefined): Provider =>
  account?.provider ?? "codex";
const agentProvider = (agent: AgentProfile | null | undefined): Provider =>
  agent?.provider ?? (agent?.id === "claude" ? "claude" : "codex");
const providerLabel = (provider: Provider) => (provider === "claude" ? "Claude" : "Codex");

// Id de l'agent integre correspondant a un provider : sert a lancer un compte
// Claude avec l'agent Claude, un compte Codex avec l'agent Codex.
const providerAgentId = (provider: Provider): string =>
  settings?.agents.find((agent) => (agent.provider ?? "codex") === provider && agent.builtin)?.id ??
  settings?.agents.find((agent) => agent.id === provider)?.id ??
  provider;

const agentCommand = (agent: AgentProfile | null | undefined) => agent?.command.trim() || "codex";

// Agent CLI "premier rang" (Codex ou Claude Code integre) : recoit un flag
// bypass et voit ses sessions capturees pour la reprise. Un agent CLI generique
// (autre binaire) n'en beneficie pas.
const isFirstPartyAgent = (agent: AgentProfile | null | undefined) =>
  agent?.builtin === true || agent?.id === "codex" || agent?.id === "claude";

// Vrai uniquement pour un agent Codex (chemins specifiques au pool ChatGPT).
const isCodexAgent = (agent: AgentProfile | null | undefined) => agentProvider(agent) === "codex";

const CODEX_BYPASS_FLAG = "--dangerously-bypass-approvals-and-sandbox";
const CLAUDE_BYPASS_FLAG = "--dangerously-skip-permissions";
const providerBypassFlag = (provider: Provider) =>
  provider === "claude" ? CLAUDE_BYPASS_FLAG : CODEX_BYPASS_FLAG;

// Le bypass est un reglage PAR COMPTE (defaut ON). Un compte sans champ `bypass`
// (config anterieure) retombe sur le defaut global `codexBypass`, puis `true`.
const accountBypassEnabled = (account: AccountProfile | null | undefined) =>
  account?.bypass ?? settings?.codexBypass ?? true;

const isCodexReasoningEffort = (value: string | null | undefined): value is CodexReasoningEffort =>
  typeof value === "string" && /^[a-z][a-z0-9_-]{0,31}$/.test(value);

const normalizeCodexReasoningEffort = (
  value: string | null | undefined,
): CodexReasoningEffort =>
  isCodexReasoningEffort(value) ? value : DEFAULT_CODEX_REASONING_EFFORT;

const providerDefaultModel = (provider: Provider) =>
  provider === "claude" ? DEFAULT_CLAUDE_MODEL : DEFAULT_CODEX_MODEL;

const accountModel = (account: AccountProfile | null | undefined) =>
  account?.model?.trim() || providerDefaultModel(accountProvider(account));

const accountReasoningEffort = (account: AccountProfile | null | undefined) =>
  normalizeCodexReasoningEffort(account?.reasoningEffort);

const reasoningEffortLabel = (effort: CodexReasoningEffort) =>
  CODEX_REASONING_EFFORTS.find((item) => item.value === effort)?.label ?? effort;

const chatCatalogModel = (
  account: AccountProfile | null | undefined,
  model: string,
): AccountModelView | null =>
  (account ? chatModelCatalogs.get(account.id) : undefined)?.find(
    (candidate) => candidate.id.toLocaleLowerCase() === model.toLocaleLowerCase(),
  ) ?? null;

const fallbackReasoningEffortsForModel = (model: string): CodexReasoningEffort[] => {
  const normalized = model.toLocaleLowerCase();
  if (normalized === "gpt-5.6-sol" || normalized === "gpt-5.6-terra") {
    return ["low", "medium", "high", "xhigh", "max", "ultra"];
  }
  if (normalized === "gpt-5.6-luna") {
    return ["low", "medium", "high", "xhigh", "max"];
  }
  return ["low", "medium", "high", "xhigh"];
};

const reasoningEffortsForChatModel = (
  account: AccountProfile | null | undefined,
  model: string,
): CodexReasoningEffort[] => {
  const advertised =
    chatCatalogModel(account, model)?.supportedReasoningEfforts
      .map((item) => item.reasoningEffort)
      .filter(isCodexReasoningEffort) ?? [];
  return advertised.length ? advertised : fallbackReasoningEffortsForModel(model);
};

const reasoningEffortForChatModel = (
  account: AccountProfile | null | undefined,
  model: string,
  requested: string | null | undefined,
): CodexReasoningEffort => {
  const supported = reasoningEffortsForChatModel(account, model);
  if (isCodexReasoningEffort(requested) && supported.includes(requested)) return requested;
  const advertisedDefault = chatCatalogModel(account, model)?.defaultReasoningEffort;
  if (isCodexReasoningEffort(advertisedDefault) && supported.includes(advertisedDefault)) {
    return advertisedDefault;
  }
  if (supported.includes(DEFAULT_CODEX_REASONING_EFFORT)) {
    return DEFAULT_CODEX_REASONING_EFFORT;
  }
  return supported[0] ?? DEFAULT_CODEX_REASONING_EFFORT;
};

const chatReasoningEffortOptions = (
  account: AccountProfile | null | undefined,
  model: string,
) =>
  reasoningEffortsForChatModel(account, model).map((value) => ({
    value,
    label: reasoningEffortLabel(value),
  }));

const loadChatModelCatalog = async (accountId: string | null | undefined) => {
  if (!accountId || chatModelCatalogs.has(accountId) || chatModelCatalogLoads.has(accountId)) return;
  const account = accountById(accountId);
  if (!account || accountProvider(account) !== "codex") return;
  chatModelCatalogLoads.add(accountId);
  try {
    const catalog = await invoke<AccountModelView[]>("account_model_catalog", { accountId });
    if (catalog.length) chatModelCatalogs.set(accountId, catalog);
  } catch {
    // Les valeurs de secours restent utilisables avec un ancien backend/CLI.
  } finally {
    chatModelCatalogLoads.delete(accountId);
    const accountIsVisible = expertChatPanes.some(
      (pane) => expertChatSelectedAccount(pane)?.id === accountId,
    );
    if (activeView === "chat" && accountIsVisible) render();
  }
};

const reasoningEffortOptions = (selected: string | null | undefined) => {
  const normalized = normalizeCodexReasoningEffort(selected);
  return CODEX_REASONING_EFFORTS.map(
    (item) =>
      `<option value="${item.value}" ${item.value === normalized ? "selected" : ""}>${item.label}</option>`,
  ).join("");
};

const renderCodexModelSuggestions = () => `
  <datalist id="codexModelSuggestions">
    ${[...CODEX_MODEL_SUGGESTIONS, ...CLAUDE_MODEL_SUGGESTIONS]
      .map((model) => `<option value="${escapeAttr(model)}"></option>`)
      .join("")}
  </datalist>
`;

const provisionAccountHome = (account: AccountProfile) =>
  invoke("ensure_account_home", {
    codexHome: account.codexHome,
    provider: accountProvider(account),
    bypass: accountBypassEnabled(account),
    model: accountModel(account),
    reasoningEffort: accountReasoningEffort(account),
  });

// Commande a taper dans le PTY pour lancer un agent. Pour Codex, ajoute le flag
// bypass quand le compte concerne l'a active (defaut), sauf s'il est deja
// present dans une commande personnalisee.
const agentRunCommand = (
  agent: AgentProfile | null | undefined,
  account: AccountProfile | null | undefined = null,
) => {
  const base = agentCommand(agent);
  if (isFirstPartyAgent(agent) && accountBypassEnabled(account)) {
    const flag = providerBypassFlag(agentProvider(agent));
    if (!base.includes(flag)) return `${base} ${flag}`;
  }
  return base;
};

const agentIsIde = (agent: AgentProfile | null | undefined) => agent?.kind === "ide";

// Dossier projet a ouvrir pour un agent IDE / Kombai. Pour une action liee au
// terminal actif, son workspace gagne toujours sur le selecteur global.
const currentProjectDir = () =>
  activeTerminal()?.workspacePath ??
  currentWorkspace() ??
  activeTerminal()?.projectDir ??
  selectedAccount()?.projectDir?.trim() ??
  null;

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

const terminalSessionsForFolder = (folderPath: string | null | undefined) =>
  terminalsForFolder(terminalSessions, folderPath);

const expertTerminalSessions = () =>
  terminalFolderFilter === null
    ? []
    : terminalSessionsForFolder(terminalFolderFilter).slice(0, EXPERT_MAX_TERMINALS);

const expertGridSlotCount = () => Math.max(2, expertTerminalSessions().length);

const expertGridColumnCount = (slotCount = expertGridSlotCount()) => {
  if (expertGridLayout !== "auto") {
    return Math.min(Number(expertGridLayout), slotCount);
  }
  if (slotCount <= 2) return 2;
  if (slotCount <= 4) return 2;
  if (slotCount <= 9) return 3;
  return 4;
};

type TerminalWorkspaceGroup = {
  key: string;
  path: string | null;
  label: string;
  detail: string;
  selectable: boolean;
  sessions: TerminalSession[];
};

const DEFAULT_WORKSPACE_KEY = "workspace:default";

const workspaceKeyForPath = (path: string) => `workspace:${normalizeWorkspacePath(path)}`;

const terminalWorkspaceDescriptor = (
  session: TerminalSession,
): Omit<TerminalWorkspaceGroup, "sessions"> => {
  const folderPath = session.folderPath?.trim();
  if (folderPath) {
    return {
      key: workspaceKeyForPath(folderPath),
      path: folderPath,
      label: workspaceBaseName(folderPath),
      detail: folderPath,
      selectable: true,
    };
  }

  // En mode web, projectDir est une URL Git et non un chemin navigable du
  // serveur. On regroupe quand meme les terminaux du meme depot, sans proposer
  // cette URL comme workspace existant.
  const repository = isRemoteMode() ? session.projectDir?.trim() : null;
  if (repository) {
    return {
      key: `repository:${repository.toLocaleLowerCase()}`,
      path: null,
      label: workspaceBaseName(repository),
      detail: repository,
      selectable: false,
    };
  }

  return {
    key: DEFAULT_WORKSPACE_KEY,
    path: null,
    label: "Sans environnement",
    detail: isRemoteMode() ? "Environnement genere par le serveur" : "Environnement non selectionne",
    selectable: true,
  };
};

const terminalWorkspaceGroups = (): TerminalWorkspaceGroup[] => {
  const groups = new Map<string, TerminalWorkspaceGroup>();
  const addPath = (path: string, label = workspaceBaseName(path)) => {
    const trimmed = path.trim();
    if (!trimmed) return;
    const key = workspaceKeyForPath(trimmed);
    if (!groups.has(key)) {
      groups.set(key, {
        key,
        path: trimmed,
        label,
        detail: trimmed,
        selectable: true,
        sessions: [],
      });
    }
  };

  // La liste canonique contient le registre synchronise, le MRU local, le
  // workspace actif et ceux derives des discussions. Un meme chemin ne cree
  // donc qu'un groupe, auquel toutes ses sessions sont ajoutees ci-dessous.
  knownWorkspaces().forEach((workspace) => addPath(workspace.path, workspace.label));

  terminalSessions.forEach((session) => {
    const descriptor = terminalWorkspaceDescriptor(session);
    let group = groups.get(descriptor.key);
    if (!group) {
      group = { ...descriptor, sessions: [] };
      groups.set(descriptor.key, group);
    }
    group.sessions.push(session);
  });

  if (groups.size === 0) {
    groups.set(DEFAULT_WORKSPACE_KEY, {
      key: DEFAULT_WORKSPACE_KEY,
      path: null,
      label: "Sans environnement",
      detail: isRemoteMode() ? "Environnement genere par le serveur" : "Environnement non selectionne",
      selectable: true,
      sessions: [],
    });
  }

  return Array.from(groups.values());
};

type TerminalEnvironmentGroup = TerminalWorkspaceGroup & { path: string };

const terminalEnvironmentGroups = (): TerminalEnvironmentGroup[] =>
  terminalWorkspaceGroups().filter((group): group is TerminalEnvironmentGroup => {
    const path = userEnvironmentPath(group.path);
    return !!path && !workspaceIsClosed(path);
  }).sort(
    (left, right) =>
      left.label.localeCompare(right.label) ||
      normalizeWorkspacePath(left.path).localeCompare(normalizeWorkspacePath(right.path)),
  );

// L'environnement est le contexte global de travail : conversations, agents,
// collaboration et terminaux suivent tous cette selection unique.
const selectEnvironment = (path: string): void => {
  const environmentPath = userEnvironmentPath(path);
  if (!environmentPath) {
    statusText = "Les workspaces techniques des agents ne peuvent pas devenir des environnements";
    terminalEnvironmentMenuOpen = false;
    render();
    return;
  }
  setCurrentWorkspace(environmentPath);
  setChatWorkspaceFilter(workspaceIdForPath(environmentPath));
  pendingChatWorkspace = null;
  terminalFolderFilter = environmentPath;
  terminalEnvironmentMenuOpen = false;
  expertChatFullscreenKey = null;
  expertTerminalFullscreenKey = null;
  roomStatus = null;
  roomMessages = [];
  void upsertWorkspaceRegistry(environmentPath);
  expertChatPage = 0;
  reconcileExpertChatPage();
  setActiveView("chat");
};

const openTerminalEnvironmentMenu = () => {
  if (!settings) return;
  terminalEnvironmentMenuOpen = true;
  statusText = "Menu des environnements";
  render();
};

const closeTerminalEnvironmentMenu = () => {
  if (!terminalEnvironmentMenuOpen) return;
  terminalEnvironmentMenuOpen = false;
  render();
};

const toggleTerminalEnvironmentMenu = () => {
  if (terminalEnvironmentMenuOpen) closeTerminalEnvironmentMenu();
  else openTerminalEnvironmentMenu();
};

const activateTerminalSession = (session: TerminalSession) => {
  activeTerminalKey = session.key;
  selectedAccountId = session.accountId;
  // Un terminal deja ouvert reste utilisable apres fermeture de son dossier,
  // sans le rouvrir implicitement. Seule une action explicite sur le groupe ou
  // le selecteur retire le tombstone synchronise.
  if (!session.folderPath || !workspaceIsClosed(session.folderPath)) {
    setCurrentWorkspace(session.folderPath);
  }
  terminalFolderFilter = session.folderPath;
  if (settings && session.agentId && settings.agents.some((agent) => agent.id === session.agentId)) {
    settings.activeAgentId = session.agentId;
  }
};

const toggleExpertTerminalFullscreen = (session: TerminalSession) => {
  if (!terminalSessions.includes(session)) return;
  expertTerminalFullscreenKey =
    expertTerminalFullscreenKey === session.key ? null : session.key;
  activateTerminalSession(session);
  requestTerminalFocusKey = session.key;
  statusText = expertTerminalFullscreenKey
    ? `Terminal en plein ecran: ${terminalTitle(session)}`
    : "Mur de terminaux";
  render();
};

const fitAndResizeTerminal = (session: TerminalSession) => {
  const element = session.terminal.element;
  const host = element?.parentElement;
  if (!host || host.clientWidth < 2 || host.clientHeight < 2) return;

  try {
    session.fitAddon.fit();
  } catch {
    return;
  }

  if (session.ptyId !== null) {
    void invoke("resize_terminal", {
      id: session.ptyId,
      cols: session.terminal.cols,
      rows: session.terminal.rows,
    }).catch(() => undefined);
  }
};

const fitAndResizeActiveTerminal = () => {
  const session = activeTerminal();
  if (session) fitAndResizeTerminal(session);
};

const fitAndResizeExpertTerminals = () => {
  expertTerminalSessions().forEach(fitAndResizeTerminal);
};

const fitAndResizeVisibleTerminals = () => {
  if (activeView === "terminal") {
    fitAndResizeExpertTerminals();
  } else {
    fitAndResizeActiveTerminal();
  }
};

const projectFieldLabel = () => (isRemoteMode() ? "Repo Git optionnel" : "Environnement projet");
const projectFieldPlaceholder = () =>
  isRemoteMode() ? "https://github.com/org/repo.git" : "C:\\chemin\\vers\\projet";
const displayProjectDir = (projectDir?: string | null) =>
  projectDir?.trim() || (isRemoteMode() ? "environnement vide" : "environnement non selectionne");

const maskProxy = (value: string) =>
  value.replace(/:\/\/([^:@/]+):([^@/]+)@/, "://$1:***@");

let fullscreenToggleInFlight = false;
let fullscreenSyncQueued = false;
let fullscreenSyncFrame: number | null = null;

const scheduleFullscreenSync = () => {
  if (fullscreenToggleInFlight) {
    fullscreenSyncQueued = true;
    return;
  }
  if (fullscreenSyncFrame !== null) return;

  fullscreenSyncFrame = window.requestAnimationFrame(() => {
    fullscreenSyncFrame = null;
    void appWindow.isFullscreen().then(async (fullscreen) => {
      if (fullscreen === isFullscreen) return;
      isFullscreen = fullscreen;
      statusText = fullscreen ? "Mode plein ecran" : "Mode fenetre";
      render();
      await waitForFrame();
      fitAndResizeVisibleTerminals();
    }).catch(() => undefined);
  });
};

const toggleFullscreen = async () => {
  fullscreenToggleInFlight = true;
  try {
    const nextFullscreen = !(await appWindow.isFullscreen());
    await appWindow.setFullscreen(nextFullscreen);
    isFullscreen = await appWindow.isFullscreen();
    statusText = isFullscreen ? "Mode plein ecran" : "Mode fenetre";
    render();
    await waitForFrame();
    fitAndResizeVisibleTerminals();
  } catch (error) {
    statusText = String(error);
    render();
  } finally {
    fullscreenToggleInFlight = false;
    if (fullscreenSyncQueued) {
      fullscreenSyncQueued = false;
      scheduleFullscreenSync();
    }
  }
};

const saveSettings = async () => {
  if (!settings) return;
  try {
    settings.defaultAccountId = selectedAccountId;
    settings = await invoke<AppSettings>("save_settings", { settings });
    const account = selectedAccount();
    if (account) {
      await provisionAccountHome(account);
    }
    statusText = "Configuration enregistree";
  } catch (error) {
    statusText = String(error);
  }
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
// Collaboration native entre agents du workspace actif
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

const renderRoomCoordinationInner = (): string => {
  const coordination = roomStatus?.snapshot.coordination;
  if (!coordination) return "";
  const tasks = coordination.tasks.slice(0, 6);
  const landed = coordination.recentLanded.slice(0, 6);
  return `
    <div class="room-coordination-summary">
      <span><strong>${coordination.queued}</strong> en attente</span>
      <span><strong>${coordination.running}</strong> en intégration</span>
      <span class="ok"><strong>${coordination.landed}</strong> landed</span>
      <span class="${coordination.attention ? "warn" : ""}"><strong>${coordination.attention}</strong> à reprendre</span>
    </div>
    <div class="room-coordination-lists">
      <div>
        <small>Task board</small>
        ${
          tasks.length
            ? tasks
                .map(
                  (task) =>
                    `<span class="room-coordination-item ${task.status}"><b>${escapeHtml(task.id)}</b> · ${escapeHtml(task.claimedBy)}</span>`,
                )
                .join("")
            : `<span class="room-coordination-empty">Aucune tâche claimée</span>`
        }
      </div>
      <div>
        <small>Derniers landed</small>
        ${
          landed.length
            ? landed
                .map(
                  (merge) =>
                    `<span class="room-coordination-item landed"><b>#${merge.id}</b> · ${escapeHtml((merge.landedSha ?? "").slice(0, 10))}</span>`,
                )
                .join("")
            : `<span class="room-coordination-empty">Aucun merge atterri</span>`
        }
      </div>
    </div>`;
};

const roomTargetOptions = (): string =>
  roomPresentAgents()
    .map(
      (agent) =>
        `<option value="${escapeAttr(agent.ident)}" ${agent.ident === roomComposeTarget ? "selected" : ""}>${escapeHtml(agent.label)} (privé)</option>`,
    )
    .join("");

// ---------------------------------------------------------------------------
// Audit design (détecteur Impeccable, exécuté côté navigateur)
// ---------------------------------------------------------------------------
// Le détecteur Impeccable (bundle autonome Apache-2.0, vendu dans
// public/impeccable/) analyse la PAGE COURANTE et renvoie la liste des
// anti-patterns de design. Il tourne dans le navigateur, donc identiquement en
// desktop (webview Tauri) et en web/mobile — aucun backend requis. On force
// `autoScan:false` pour qu'il ne dessine aucun overlay au chargement : la
// détection n'a lieu que sur clic du bouton « Auditer cette page ».

const IMPECCABLE_DETECTOR_SRC = "/impeccable/detect-antipatterns-browser.js";
// error < warning < advisory ; les sévérités inconnues sont triées en dernier.
const AUDIT_SEVERITY_RANK: Record<string, number> = { error: 0, warning: 1, advisory: 2 };
// Sévérité inconnue → triée après les sévérités connues.
const auditSeverityRank = (severity: string): number =>
  AUDIT_SEVERITY_RANK[severity] ?? Number.MAX_SAFE_INTEGER;
// Message « rien à signaler » (source unique, affiché une seule fois).
const AUDIT_CLEAN_MESSAGE = "Aucun anti-pattern détecté 🎉";

// Libellé FR de la vue auditée, pour l'en-tête du rapport.
const auditViewLabelFor = (view: AppView): string => {
  switch (view) {
    case "audit":
      return "écran d'audit";
    case "pool":
      return "vue Pool";
    case "limits":
      return "vue Limites";
    case "dashboard":
      return "vue Stats";
    case "kombai":
      return "vue Kombai";
    case "discussions":
      return "vue Discussions";
    case "history":
      return "vue Historique";
    case "room":
      return "vue Salon";
    case "settings":
      return "vue Paramètres";
    case "chat":
      return "vue Conversation";
    default:
      return "vue Terminal";
  }
};

type ImpeccableWindow = Window & {
  impeccableDetect?: (options?: Record<string, unknown>) => unknown;
  __IMPECCABLE_CONFIG__?: Record<string, unknown>;
};

const auditSeverityLabel = (severity: string): string =>
  severity === "error"
    ? "Erreur"
    : severity === "warning"
      ? "Alerte"
      : severity === "advisory"
        ? "Conseil"
        : severity;

const auditCategoryLabel = (category: string): string =>
  category === "slop" ? "IA slop" : category === "quality" ? "Qualité" : category;

// Injecte le bundle détecteur une seule fois (mémoïsé). `__IMPECCABLE_CONFIG__`
// est posé AVANT l'insertion du <script> pour désactiver le scan auto : sinon le
// bundle dessine des overlays sur toute l'app dès son chargement.
const ensureImpeccableLoaded = (): Promise<void> => {
  const impeccableWindow = window as ImpeccableWindow;
  if (typeof impeccableWindow.impeccableDetect === "function") return Promise.resolve();
  if (impeccableLoadPromise) return impeccableLoadPromise;

  impeccableWindow.__IMPECCABLE_CONFIG__ = {
    ...(impeccableWindow.__IMPECCABLE_CONFIG__ ?? {}),
    autoScan: false,
  };

  impeccableLoadPromise = new Promise<void>((resolve, reject) => {
    const script = document.createElement("script");
    script.src = IMPECCABLE_DETECTOR_SRC;
    script.async = true;
    script.dataset.impeccable = "true";
    script.addEventListener("load", () => {
      if (typeof impeccableWindow.impeccableDetect === "function") resolve();
      else reject(new Error("Détecteur chargé mais API absente"));
    });
    script.addEventListener("error", () =>
      reject(new Error("Chargement du détecteur Impeccable impossible")),
    );
    document.head.appendChild(script);
  }).catch((error) => {
    // Autorise une nouvelle tentative au prochain clic.
    impeccableLoadPromise = null;
    throw error;
  });

  return impeccableLoadPromise;
};

// La sortie sérialisée du détecteur est un tableau de groupes
// {selector, tagName, findings[]}. On l'aplati en une liste de findings enrichis
// du sélecteur de leur élément (pour pouvoir les mettre en évidence ensuite).
const flattenAuditFindings = (raw: unknown): AuditFinding[] => {
  if (!Array.isArray(raw)) return [];
  const findings: AuditFinding[] = [];
  for (const group of raw) {
    const selector = typeof group?.selector === "string" ? group.selector : "";
    const tagName = typeof group?.tagName === "string" ? group.tagName : "";
    const groupFindings = Array.isArray(group?.findings) ? group.findings : [];
    for (const item of groupFindings) {
      findings.push({
        type: String(item?.type ?? "unknown"),
        category: String(item?.category ?? "quality"),
        severity: String(item?.severity ?? "warning"),
        detail: String(item?.detail ?? ""),
        name: String(item?.name ?? item?.type ?? "Anti-pattern"),
        description: String(item?.description ?? ""),
        selector,
        tagName,
      });
    }
  }
  return findings;
};

const runAudit = async (sourceLabel: string): Promise<void> => {
  auditLoading = true;
  auditError = null;
  auditViewLabel = sourceLabel;
  statusText = `Audit design de la ${sourceLabel}…`;
  render();
  try {
    await ensureImpeccableLoaded();
    const detect = (window as ImpeccableWindow).impeccableDetect;
    if (typeof detect !== "function") throw new Error("Détecteur indisponible");
    auditFindings = flattenAuditFindings(detect({ serialize: true }));
    statusText = `Audit design : ${auditFindings.length} problème(s) détecté(s)`;
  } catch (error) {
    auditError = String((error as Error)?.message ?? error);
    statusText = "Audit design : échec";
  } finally {
    auditLoading = false;
    render();
  }
};

// Ouvre/ferme la vue d'audit. À l'OUVERTURE, on lance d'abord le détecteur sur la
// VUE COURANTE (avant de basculer : son DOM n'est plus monté une fois la vue
// « audit » affichée), puis on montre le rapport.
const toggleAudit = async (): Promise<void> => {
  if (activeView === "audit") {
    setActiveView("audit"); // referme la vue (revient au terminal)
    return;
  }
  await runAudit(auditViewLabelFor(activeView));
  setActiveView("audit");
};

// Fait défiler jusqu'à l'élément fautif et l'entoure brièvement.
const highlightAuditTarget = (selector: string): void => {
  if (!selector) return;
  let target: Element | null = null;
  try {
    target = document.querySelector(selector);
  } catch {
    target = null;
  }
  if (!target) {
    statusText = "Élément introuvable dans la page (le DOM a peut-être changé)";
    render();
    return;
  }
  target.scrollIntoView({ behavior: "smooth", block: "center" });
  target.classList.add("audit-highlight");
  window.setTimeout(() => target?.classList.remove("audit-highlight"), 2200);
};

const renderAuditFinding = (finding: AuditFinding): string => {
  const location = finding.selector
    ? `${finding.tagName || "élément"} · ${finding.selector}`
    : "niveau page";
  return `
    <button type="button" class="audit-finding" data-audit-selector="${escapeAttr(finding.selector)}" title="Mettre en évidence dans la page">
      <span class="audit-badge sev-${escapeAttr(finding.severity)}">${escapeHtml(auditSeverityLabel(finding.severity))}</span>
      <span class="audit-finding-main">
        <span class="audit-finding-head">
          <strong>${escapeHtml(finding.name)}</strong>
          <span class="audit-cat">${escapeHtml(auditCategoryLabel(finding.category))}</span>
        </span>
        ${finding.detail ? `<span class="audit-detail">${escapeHtml(finding.detail)}</span>` : ""}
        ${finding.description ? `<span class="audit-desc">${escapeHtml(finding.description)}</span>` : ""}
        <span class="audit-target">${escapeHtml(location)}</span>
      </span>
    </button>`;
};

const renderAuditPanel = (): string => {
  const findings = auditFindings ?? [];
  const ran = auditFindings !== null;
  const target = auditViewLabel ?? "interface";
  const sorted = [...findings].sort(
    (a, b) =>
      auditSeverityRank(a.severity) - auditSeverityRank(b.severity) ||
      a.category.localeCompare(b.category) ||
      a.name.localeCompare(b.name),
  );
  const counts = findings.reduce<Record<string, number>>((acc, finding) => {
    acc[finding.severity] = (acc[finding.severity] ?? 0) + 1;
    return acc;
  }, {});
  const countsText = Object.entries(counts)
    .sort(([a], [b]) => auditSeverityRank(a) - auditSeverityRank(b))
    .map(([severity, n]) => `${n} ${auditSeverityLabel(severity).toLowerCase()}`)
    .join(" · ");

  const summary = ran
    ? `Audit · ${target} — ${findings.length} problème(s)${findings.length ? ` · ${countsText}` : ""}`
    : "Depuis la vue à auditer, clique « Audit » dans la barre d'outils. Le détecteur Impeccable analyse l'interface affichée, entièrement dans le navigateur (rien n'est envoyé à un serveur).";

  const body = auditError
    ? `<div class="empty audit-error">${escapeHtml(auditError)}</div>`
    : auditLoading
      ? `<div class="empty">Analyse en cours…</div>`
      : !ran
        ? `<div class="empty">Aucun audit lancé pour l'instant.</div>`
        : findings.length === 0
          ? `<div class="empty">${AUDIT_CLEAN_MESSAGE}</div>`
          : `<div id="auditList" class="audit-list">${sorted.map(renderAuditFinding).join("")}</div>`;

  return `
    <div class="panel audit-panel">
      <div class="panel-head">
        <div>
          <h2>Audit design</h2>
          <p class="panel-sub">${escapeHtml(summary)}</p>
        </div>
        <div class="panel-actions">
          <button id="auditRun" class="tool-button primary" ${auditLoading ? "disabled" : ""} title="Relancer l'audit sur l'écran actuel">
            <i data-lucide="scan-eye"></i><span>${ran ? "Relancer" : "Auditer"}</span>
          </button>
        </div>
      </div>
      ${body}
    </div>`;
};

// ---------------------------------------------------------------------------
// Bibliothèque de skills (vue « Skills »)
// ---------------------------------------------------------------------------
// Source INDÉPENDANTE (aucune dépendance à AgentsRoom) : fichiers statiques
// embarqués sous public/skills/ (copiés dans dist/ au build, servis à /skills/…).
// On lit le manifeste index.json puis le contenu .md de chaque skill par fetch —
// identique en desktop (webview), web et mobile, sans backend. Ajouter un skill =
// déposer un .md dans public/skills/ et l'ajouter à index.json.
const SKILLS_INDEX_URL = "/skills/index.json";

const refreshSkills = async (): Promise<void> => {
  try {
    const indexResponse = await fetch(SKILLS_INDEX_URL, { cache: "no-cache" });
    if (!indexResponse.ok) throw new Error(`index.json: HTTP ${indexResponse.status}`);
    const index = (await indexResponse.json()) as { skills?: unknown };
    const entries = Array.isArray(index.skills) ? index.skills : [];
    skillsList = await Promise.all(
      entries.map(async (raw): Promise<SkillEntry> => {
        const entry = (raw ?? {}) as Record<string, unknown>;
        const file = String(entry.file ?? "");
        let content = "";
        try {
          const contentResponse = await fetch(`/skills/${file}`, { cache: "no-cache" });
          if (contentResponse.ok) content = await contentResponse.text();
        } catch {
          // contenu indisponible : la carte reste affichée sans corps
        }
        return {
          id: String(entry.id ?? file),
          name: String(entry.name ?? entry.id ?? "skill"),
          description: String(entry.description ?? ""),
          tags: Array.isArray(entry.tags) ? entry.tags.map(String) : [],
          content,
        };
      }),
    );
    skillsError = null;
  } catch (error) {
    skillsError = String((error as Error)?.message ?? error);
  }
  skillsLoaded = true;
  if (activeView === "skills") render();
};

// Colle du texte (potentiellement multi-lignes) dans la session Codex active via
// le MODE PASTE (bracketed paste : ESC[200~ … ESC[201~), SANS Entrée : le contenu
// atterrit dans le composer de Codex, l'utilisateur relit puis valide. `sendLine`
// (qui ajoute \r) soumettrait dès le premier saut de ligne.
const pasteToActiveSession = async (text: string): Promise<boolean> => {
  const session = activeTerminal();
  if (!session?.running || session.ptyId === null) return false;
  try {
    await invoke("write_terminal", {
      id: session.ptyId,
      data: `[200~${text}[201~`,
    });
    return true;
  } catch (error) {
    statusText = String(error);
    return false;
  }
};

const applySkill = async (id: string): Promise<void> => {
  const skill = (skillsList ?? []).find((entry) => entry.id === id);
  if (!skill) return;
  const content = skill.content.trim();
  if (!content) {
    statusText = `Le contenu du skill « ${skill.name} » est indisponible`;
    render();
    return;
  }

  // L'injection cible le panneau actif et précède le brouillon existant afin
  // que les instructions du skill encadrent bien la demande déjà saisie.
  const pane = activeExpertChatPane();
  if (!pane) return;
  const existingDraft = pane.draft.trim();
  pane.draft = existingDraft ? `${content}\n\n${existingDraft}` : content;
  setActiveView("chat");
  statusText = `Skill « ${skill.name} » ajouté au chat`;
  window.setTimeout(() => {
    const input = expertChatPaneRoot(pane)?.querySelector<HTMLTextAreaElement>("[data-chat-control='prompt']");
    if (!input) return;
    input.focus();
    input.setSelectionRange(input.value.length, input.value.length);
  }, 0);
};

const copySkill = async (id: string): Promise<void> => {
  const skill = (skillsList ?? []).find((entry) => entry.id === id);
  if (!skill) return;
  try {
    await navigator.clipboard.writeText(skill.content);
    statusText = `Skill « ${skill.name} » copié dans le presse-papiers`;
  } catch {
    statusText = "Copie impossible (presse-papiers indisponible)";
  }
  render();
};

const renderSkillCard = (
  skill: SkillEntry,
  applyTarget: "chat" | "terminal",
  hasActiveSession: boolean,
): string => {
  const tags = skill.tags
    .slice(0, 6)
    .map((tag) => `<span class="skill-tag">${escapeHtml(tag)}</span>`)
    .join("");
  const applyToChat = applyTarget === "chat";
  const hasContent = skill.content.trim().length > 0;
  const canApply = hasContent && (applyToChat || hasActiveSession);
  const applyLabel = applyToChat ? "Ajouter au chat" : "Injecter dans Codex";
  const applyTitle = !hasContent
    ? "Contenu du skill indisponible"
    : applyToChat
      ? "Ajouter le skill au brouillon du chat"
      : hasActiveSession
        ? "Coller le skill dans la session Codex active (relis puis Entrée)"
        : "Aucune session Codex active";
  return `
    <div class="skill-card">
      <div class="skill-card-head">
        <strong>${escapeHtml(skill.name)}</strong>
      </div>
      ${skill.description ? `<p class="skill-desc">${escapeHtml(skill.description)}</p>` : ""}
      ${tags ? `<div class="skill-tags">${tags}</div>` : ""}
      <div class="skill-actions">
        <button class="tool-button primary" data-skill-apply="${escapeAttr(skill.id)}" ${canApply ? "" : "disabled"} title="${escapeAttr(applyTitle)}">
          <i data-lucide="send"></i><span>${applyLabel}</span>
        </button>
        <button class="tool-button" data-skill-copy="${escapeAttr(skill.id)}" title="Copier le contenu du skill dans le presse-papiers">
          <i data-lucide="copy"></i><span>Copier</span>
        </button>
      </div>
      <details class="skill-details">
        <summary>Voir le contenu</summary>
        <pre class="skill-content">${escapeHtml(skill.content)}</pre>
      </details>
    </div>`;
};

const renderSkillsPanel = (): string => {
  const skills = skillsList ?? [];
  const applyTarget = "chat" as const;
  const hasActiveSession = activeTerminal()?.running ?? false;
  const sub = !skillsLoaded
    ? "Chargement…"
    : applyTarget === "chat"
      ? `${skills.length} skill(s) disponible(s) · ajoute-les au brouillon de ton chat`
      : `${skills.length} skill(s) disponible(s)${hasActiveSession ? "" : " · démarre un terminal Codex pour pouvoir les injecter"}`;

  const body = skillsError
    ? `<div class="empty audit-error">${escapeHtml(skillsError)}</div>`
    : !skillsLoaded
      ? `<div class="empty">Chargement des skills…</div>`
      : skills.length === 0
        ? `<div class="empty">Aucun skill trouvé (<code>public/skills/index.json</code>).</div>`
        : `<div id="skillsList" class="skills-list">${skills.map((skill) => renderSkillCard(skill, applyTarget, hasActiveSession)).join("")}</div>`;

  return `
    <div class="panel audit-panel skills-panel">
      <div class="panel-head">
        <div>
          <h2>Skills</h2>
          <p class="panel-sub">${escapeHtml(sub)}</p>
        </div>
        <div class="panel-actions">
          <button id="skillsRefresh" class="icon-button wide" title="Rafraîchir la bibliothèque"><i data-lucide="refresh-ccw"></i></button>
        </div>
      </div>
      ${body}
    </div>`;
};

const renderRoomPanel = (): string => {
  const running = roomStatus?.running ?? false;
  const present = roomStatus?.snapshot.present ?? 0;
  const workspace = currentWorkspace();
  const sub = `${running ? "Active automatiquement" : "Service indisponible"} · ${present} agent(s) présent(s) · ${workspace ? escapeHtml(workspaceBaseName(workspace)) : "aucun environnement actif"}${roomStatus?.snapshot.storeOwner === false ? " · store passif" : ""}`;
  return `
    <div class="panel room-panel">
      <div class="panel-head">
        <div>
          <h2>Collaboration de l'environnement</h2>
          <p class="panel-sub">${sub}</p>
        </div>
        <div class="panel-actions">
          <button id="roomRefresh" class="icon-button wide" title="Rafraîchir"><i data-lucide="refresh-ccw"></i></button>
        </div>
      </div>
      <section id="roomCoordination" class="room-coordination">${renderRoomCoordinationInner()}</section>
      <div class="room-grid">
        <aside class="room-agents">
          <div class="section-row"><span>Présents</span></div>
          <div id="roomAgents">${renderRoomAgentsInner()}</div>
        </aside>
        <div class="room-main">
          <div id="roomFeed" class="room-feed">${renderRoomFeedInner()}</div>
          <form id="roomComposer" class="room-composer">
            <select id="roomTarget" class="agent-select" title="Destinataire" aria-label="Destinataire">
              <option value="">Environnement (tous)</option>
              ${roomTargetOptions()}
            </select>
            <input id="roomText" type="text" placeholder="Message en tant qu'opérateur…" autocomplete="off" />
            <button type="submit" class="tool-button primary" title="Envoyer"><i data-lucide="send"></i><span>Envoyer</span></button>
          </form>
        </div>
      </div>
    </div>`;
};

const renderWorkspaceLiveGraphContent = (): string => {
  const workspace = currentWorkspace();
  const agents = roomPresentAgents();
  const coordination = roomStatus?.snapshot.coordination;
  const tasks = coordination?.tasks ?? [];
  const landed = coordination?.recentLanded ?? [];
  const queued = coordination?.queued ?? 0;
  const running = coordination?.running ?? 0;
  const attention = coordination?.attention ?? 0;
  const recentMessages = roomMessages.slice(-8).reverse();
  const roomId = roomStatus?.snapshot.roomId ?? "";

  const agentNodes = agents.length
    ? agents
        .slice(0, 12)
        .map(
          (agent) => `<div class="workspace-live-agent-node">
            <span class="live-dot on"></span>
            <span><strong>${escapeHtml(agent.label)}</strong><small>${escapeHtml(agent.ident)}</small></span>
          </div>`,
        )
        .join("") +
      (agents.length > 12
        ? `<div class="workspace-live-overflow">+${agents.length - 12} autres</div>`
        : "")
    : `<div class="workspace-live-empty">Aucun agent actif</div>`;

  const taskItems = tasks.length
    ? tasks
        .slice(0, 6)
        .map(
          (task) => `<span class="workspace-live-task ${task.status}">
            <b>${escapeHtml(task.id)}</b><small>${escapeHtml(task.claimedBy)}</small>
          </span>`,
        )
        .join("")
    : `<span class="workspace-live-empty">Aucune tâche</span>`;

  const messageItems = recentMessages.length
    ? recentMessages
        .map((message) => {
          const target = message.to ? ` → ${roomAgentLabel(message.to)}` : " → environnement";
          const time = new Date(message.ts * 1000).toLocaleTimeString([], {
            hour: "2-digit",
            minute: "2-digit",
            second: "2-digit",
          });
          return `<div class="workspace-live-event ${message.kind}">
            <span class="workspace-live-event-time">${escapeHtml(time)}</span>
            <strong>${escapeHtml(message.fromLabel)}</strong>
            <span>${escapeHtml(target)}</span>
            <p>${escapeHtml(message.text)}</p>
          </div>`;
        })
        .join("")
    : `<div class="workspace-live-empty">Aucun événement récent</div>`;

  return `
    <div class="workspace-live-kpis">
      <span><b>${agents.length}</b> agents</span>
      <span><b>${tasks.filter((task) => task.status === "claimed").length}</b> tâches actives</span>
      <span><b>${queued}</b> en attente</span>
      <span class="${running ? "is-running" : ""}"><b>${running}</b> en intégration</span>
      <span class="${attention ? "needs-attention" : ""}"><b>${attention}</b> à reprendre</span>
    </div>
    <div class="workspace-live-topology">
      <section class="workspace-live-stage workspace-live-agents">
        <header><i data-lucide="bot"></i><span>Agents actifs</span></header>
        <div class="workspace-live-agent-list">${agentNodes}</div>
      </section>
      <div class="workspace-live-link ${agents.length ? "active" : ""}"><i data-lucide="arrow-right"></i></div>
      <section class="workspace-live-core ${agents.length ? "active" : ""}">
        <span class="workspace-live-core-icon"><i data-lucide="folder-git-2"></i></span>
        <strong>${escapeHtml(workspace ? workspaceBaseName(workspace) : "Environnement")}</strong>
        <small>${escapeHtml(roomId ? roomId.slice(0, 18) : "scope indisponible")}</small>
        <em>${agents.length ? "synchronisation active" : "en attente d'agents"}</em>
      </section>
      <div class="workspace-live-link ${tasks.length || queued || running ? "active" : ""}"><i data-lucide="arrow-right"></i></div>
      <section class="workspace-live-pipeline">
        <div class="workspace-live-pipeline-node">
          <header><i data-lucide="list-checks"></i><span>Task board</span><b>${tasks.length}</b></header>
          <div class="workspace-live-task-list">${taskItems}</div>
        </div>
        <div class="workspace-live-pipeline-arrow"><i data-lucide="chevron-down"></i></div>
        <div class="workspace-live-pipeline-node ${running ? "running" : ""}">
          <header><i data-lucide="git-merge"></i><span>Merge queue</span><b>${queued + running}</b></header>
          <small>${running ? `${running} intégration(s) en cours` : queued ? `${queued} soumission(s) en attente` : "File vide"}</small>
        </div>
        <div class="workspace-live-pipeline-arrow"><i data-lucide="chevron-down"></i></div>
        <div class="workspace-live-pipeline-node landed">
          <header><i data-lucide="git-commit-horizontal"></i><span>Intégrés</span><b>${coordination?.landed ?? 0}</b></header>
          <small>${landed[0]?.landedSha ? `Dernier ${escapeHtml(landed[0].landedSha!.slice(0, 10))}` : "Aucun merge récent"}</small>
        </div>
      </section>
    </div>
    <section class="workspace-live-events">
      <header><span><i data-lucide="radio"></i> Événements temps réel</span><small>Actualisation 1 s</small></header>
      <div class="workspace-live-event-list">${messageItems}</div>
    </section>`;
};

const renderWorkspaceLiveGraphModal = (): string => {
  if (!workspaceLiveGraphOpen) return "";
  const workspace = currentWorkspace();
  return `<div class="modal-backdrop workspace-live-backdrop" id="workspaceLiveGraphBackdrop">
    <section class="modal workspace-live-modal" role="dialog" aria-modal="true" aria-labelledby="workspaceLiveGraphTitle">
      <header class="modal-head workspace-live-head">
        <div>
          <span class="workspace-live-eyebrow"><i data-lucide="activity"></i> Temps réel</span>
          <h2 id="workspaceLiveGraphTitle">Activité de l'environnement</h2>
          <p>${escapeHtml(workspace ?? "Aucun environnement actif")}</p>
        </div>
        <button class="icon-button" id="closeWorkspaceLiveGraph" title="Fermer"><i data-lucide="x"></i></button>
      </header>
      <div class="workspace-live-content" id="workspaceLiveGraphContent">${renderWorkspaceLiveGraphContent()}</div>
    </section>
  </div>`;
};

const openWorkspaceLiveGraph = () => {
  if (!currentWorkspace()) {
    statusText = "Choisis d'abord un environnement";
    render();
    return;
  }
  workspaceLiveGraphOpen = true;
  render();
  startRoomPoll();
  void refreshRoom();
};

const closeWorkspaceLiveGraph = () => {
  workspaceLiveGraphOpen = false;
  if (activeView !== "room") stopRoomPoll();
  render();
};

const syncRoomTargetOptions = () => {
  const select = document.querySelector<HTMLSelectElement>("#roomTarget");
  if (!select) return;
  // Ne reconstruit que si le nombre d'agents a change (evite de casser une
  // selection en cours d'ouverture a chaque poll).
  if (select.options.length - 1 === roomPresentAgents().length) return;
  const current = select.value;
  select.innerHTML = `<option value="">Environnement (tous)</option>${roomTargetOptions()}`;
  select.value = current;
};

const refreshRoom = async () => {
  try {
    roomStatus = await invoke<RoomStatus>("room_status", {
      workspacePath: currentWorkspace(),
    });
  } catch {
    return;
  }
  try {
    const result = await invoke<{ messages: RoomMessage[]; cursor: number }>("room_messages", {
      since: 0,
      workspacePath: currentWorkspace(),
    });
    roomMessages = result.messages ?? [];
  } catch {
    // le fil reste tel quel
  }
  const liveGraph = document.querySelector<HTMLElement>("#workspaceLiveGraphContent");
  if (liveGraph) {
    liveGraph.innerHTML = renderWorkspaceLiveGraphContent();
    createIcons({ icons: lucideIcons });
  }
  if (activeView !== "room") return;
  const agentsEl = document.querySelector<HTMLDivElement>("#roomAgents");
  const feedEl = document.querySelector<HTMLDivElement>("#roomFeed");
  const coordinationEl = document.querySelector<HTMLElement>("#roomCoordination");
  if (agentsEl && feedEl) {
    const atBottom = feedEl.scrollHeight - feedEl.scrollTop - feedEl.clientHeight < 40;
    agentsEl.innerHTML = renderRoomAgentsInner();
    feedEl.innerHTML = renderRoomFeedInner();
    if (coordinationEl) coordinationEl.innerHTML = renderRoomCoordinationInner();
    syncRoomTargetOptions();
    createIcons({ icons: lucideIcons });
    if (atBottom) feedEl.scrollTop = feedEl.scrollHeight;
  } else {
    render();
  }
};

const startRoomPoll = () => {
  stopRoomPoll();
  roomPoll = window.setInterval(() => void refreshRoom(), 1000);
};

const stopRoomPoll = () => {
  if (roomPoll !== null) {
    clearInterval(roomPoll);
    roomPoll = null;
  }
};

const sendRoomMessage = async () => {
  const input = document.querySelector<HTMLInputElement>("#roomText");
  const target = document.querySelector<HTMLSelectElement>("#roomTarget");
  const text = input?.value.trim() ?? "";
  if (!text) return;
  const to = target?.value || null;
  try {
    await invoke("room_send", { text, to, workspacePath: currentWorkspace() });
    if (input) input.value = "";
  } catch (error) {
    statusText = String(error);
    render();
    return;
  }
  await refreshRoom();
};

const removeAccount = async (id: string | null, deleteFiles = false) => {
  if (!settings || !id) return;
  const account = settings.accounts.find((candidate) => candidate.id === id);
  if (!account) return;

  pendingDeleteAccountId = null;
  try {
    settings = await invoke<AppSettings>("remove_account", { accountId: id, deleteFiles });
    if (selectedAccountId === id) {
      selectedAccountId = settings.defaultAccountId ?? settings.accounts[0]?.id ?? null;
    }
    if (poolStatus?.running) {
      poolStatus = await invoke<PoolStatus>("pool_start");
      startPoolPoll();
    } else {
      poolStatus = await invoke<PoolStatus>("pool_status");
    }
    statusText = deleteFiles
      ? `Compte « ${account.label} » supprimé (environnement effacé du disque)`
      : `Compte « ${account.label} » retiré du pool`;
  } catch (error) {
    statusText = String(error);
  }
  render();
};

const ensureTerminalsRestored = async () => {
  if (terminalRestoreAttempted) {
    await terminalRestorePromise;
    return;
  }

  terminalRestoreAttempted = true;
  terminalRestorePromise = restoreTerminals();
  try {
    await terminalRestorePromise;
  } finally {
    terminalRestorePromise = null;
  }
};

const setActiveView = (view: AppView) => {
  if (view === "terminal" && !userEnvironmentPath(terminalFolderFilter)) {
    terminalFolderFilter = userEnvironmentPath(currentWorkspace());
  }
  activeView = view;
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
                  ? "Vue collaboration"
                  : activeView === "audit"
                    ? "Audit design"
                    : activeView === "skills"
                      ? "Skills"
                      : activeView === "settings"
                        ? "Paramètres"
                        : activeView === "chat"
                          ? "Vue conversation"
                          : terminalFolderFilter
                            ? `Session terminal: ${workspaceBaseName(terminalFolderFilter)}`
                            : "Choisis un environnement terminal";

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

  if (activeView === "discussions" || activeView === "chat") {
    startDiscussionsPoll();
  } else {
    stopDiscussionsPoll();
  }

  if (activeView === "chat") startAllExpertChatWork();

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
  if (activeView === "skills") void refreshSkills();
};

const refreshLimitStatus = async (silent = false) => {
  if (!silent && activeView === "limits") {
    statusText = "Lecture des limites serveur";
  }
  try {
    limitStatus = await invoke<AccountLimitView[]>("account_limit_status");
    limitStatusLoaded = true;
    if (!silent) statusText = "Limites serveur actualisees";
  } catch (error) {
    if (!silent) statusText = String(error);
    limitStatusLoaded = true;
  }

  if (activeView === "limits") {
    render();
  }
};

// Ouvre un terminal interactif `codex login` (ou l'equivalent du provider) pour
// le compte cible : c'est la seule facon de regenerer une session revoquee /
// expiree, sans laquelle la vue Limites ne peut relire aucun quota. On reutilise
// la machinerie terminal existante (meme CODEX_HOME/agent que le compte).
const reloginAccount = async (accountId: string) => {
  if (!settings) return;
  const account = settings.accounts.find((candidate) => candidate.id === accountId);
  if (!account) {
    statusText = "Compte introuvable";
    render();
    return;
  }
  const provider = accountProvider(account);
  const agentId = providerAgentId(provider);
  const agent = agentById(agentId);
  const loginSub = agent?.loginCommand?.trim() || "login";
  const environmentPath =
    userEnvironmentPath(currentWorkspace()) ?? loadWorkspacePaths()[0] ?? null;
  if (!environmentPath) {
    statusText = "Choisis d'abord un environnement (onglet Terminal) pour ouvrir la connexion";
    render();
    return;
  }
  setCurrentWorkspace(environmentPath);
  statusText = `Ouverture de la connexion ${providerLabel(provider)} pour ${account.label}…`;
  await createNewTerminal(
    accountId,
    true,
    agentSubcommand(agent, loginSub),
    agentId,
    null,
    environmentPath,
  );
};

const startLimitPoll = () => {
  stopLimitPoll();
  limitPoll = window.setInterval(() => void refreshLimitStatus(), LIMIT_POLL_INTERVAL_MS);
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

const applyDiscussionsSnapshot = (snapshot: DiscussionsView) => {
  discussions = snapshot;
  discussionsLoaded = true;
  const latestBySession = new Map(
    snapshot.accounts.flatMap((group) => group.discussions).map((discussion) => [discussion.sessionId, discussion]),
  );
  expertChatPanes.forEach((pane) => {
    if (!pane.discussion) return;
    const latest = latestBySession.get(pane.discussion.sessionId);
    if (latest) Object.assign(pane.discussion, latest);
  });
  if (activeView === "discussions") {
    const host = document.querySelector<HTMLDivElement>("#discussionGroups");
    if (host) {
      refreshDiscussionList();
    } else {
      render();
    }
  } else if (activeView === "chat") {
    const host = document.querySelector<HTMLElement>("#chatSideConversations");
    // Ne remplace jamais le DOM sous le pointeur pendant un drag natif : sinon
    // le navigateur annule le geste avant que le drop atteigne son workspace.
    if (host && !draggedChatSessionId) {
      host.innerHTML = renderChatSidebarConversations();
      createIcons({ icons: lucideIcons });
      bindDiscussionRowUi();
      bindWorkspaceSwitcherUi(host);
    }
    // Garde le compteur global des workspaces et conversations a jour.
    refreshWorkspaceSwitcher();
  }
};

const refreshDiscussions = async () => {
  try {
    applyDiscussionsSnapshot(await invoke<DiscussionsView>("list_discussions"));
  } catch (error) {
    statusText = String(error);
    discussionsLoaded = true;
  }
};

const startDiscussionsPoll = () => {
  stopDiscussionsPoll();
  if (isRemoteMode()) {
    discussionsSyncState = "connecting";
    discussionsLiveUnlisten = subscribeDiscussionUpdates(
      {},
      (message: DiscussionStreamMessage) => {
        if (message.type === "dashboard") {
          applyDiscussionsSnapshot(message.dashboard as DiscussionsView);
        } else if (message.type === "error") {
          statusText = `Synchronisation des discussions : ${message.message}`;
        }
      },
      (state) => {
        discussionsSyncState = state;
      },
    );
    // Filet de securite si un proxy intermediaire coupe durablement les WS.
    discussionsPoll = window.setInterval(() => {
      if (discussionsSyncState !== "live") void refreshDiscussions();
    }, 2000);
  } else {
    // Le bureau local n'a pas de serveur WebSocket : le scan ne tourne que tant
    // que la vue est ouverte, avec une cadence assez courte pour suivre un chat.
    discussionsPoll = window.setInterval(() => void refreshDiscussions(), 2000);
  }
};

const stopDiscussionsPoll = () => {
  discussionsLiveUnlisten?.();
  discussionsLiveUnlisten = null;
  discussionsSyncState = "closed";
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
  return [discussion.title ?? "", discussion.preview ?? "", discussionFolderPath(discussion) ?? "", discussion.sessionId, label]
    .some((field) => field.toLowerCase().includes(query));
};

const persistDiscussionFolder = async (
  discussion: DiscussionSummary,
  folderPath: string,
): Promise<DiscussionSummary> => {
  discussion.folderPath = folderPath;
  if (
    discussion.cwd?.trim() &&
    normalizeWorkspacePath(discussion.cwd) === normalizeWorkspacePath(folderPath)
  ) {
    return discussion;
  }
  const moved = await invoke<DiscussionSummary>("move_discussion", {
    accountId: discussion.accountId,
    sessionId: discussion.sessionId,
    workspacePath: folderPath,
  });
  moved.folderPath = folderPath;
  Object.assign(discussion, moved);
  return discussion;
};

const restoreDiscussionFolder = async (
  discussion: DiscussionSummary,
): Promise<string | null> => {
  const folderPath = activateDiscussionFolder(discussion);
  if (!folderPath) return null;
  await persistDiscussionFolder(discussion, folderPath);
  return folderPath;
};

// Quand un terminal isole se ferme, son transcript vient d'etre fusionne dans
// le home canonique avec le cwd du worktree. On le retrouve par son id (ou par
// ce cwd pour une nouvelle session), puis on persiste le dossier logique afin
// que la prochaine reprise retrouve la meme room.
const persistTerminalDiscussionFolder = async (session: TerminalSession): Promise<void> => {
  const folderPath = session.folderPath?.trim();
  if (!folderPath) return;
  const linkedIds = new Set(
    [session.codexSessionId, session.resumeSessionId].filter(
      (id): id is string => !!id,
    ),
  );

  for (const delay of [0, 200, 600]) {
    if (delay) await sleep(delay);
    await refreshDiscussions();
    const discussion = allDiscussions().find(
      (candidate) =>
        candidate.accountId === session.accountId &&
        (linkedIds.has(candidate.sessionId) || linkedIds.has(candidate.rolloutId)),
    ) ?? allDiscussions()
      .filter(
        (candidate) =>
          candidate.accountId === session.accountId &&
          !!candidate.cwd &&
          !!session.workspacePath &&
          normalizeWorkspacePath(candidate.cwd) === normalizeWorkspacePath(session.workspacePath) &&
          candidate.lastActivity >= (session.startedAtUnix ?? 0) - 5,
      )
      .sort((left, right) => right.lastActivity - left.lastActivity)[0];
    if (!discussion) continue;
    await persistDiscussionFolder(discussion, folderPath);
    await refreshDiscussions();
    return;
  }
};

const resumeSessionInTerminal = async (
  accountId: string,
  sessionId: string,
  folderPath: string | null,
) => {
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
  const environmentPath = userEnvironmentPath(folderPath);
  if (!environmentPath) {
    statusText = "Reprise bloquee: cette discussion n'a pas d'environnement associe";
    render();
    return;
  }
  activeView = "terminal";
  stopLimitPoll();
  stopUsagePoll();
  stopKombaiPoll();
  stopDiscussionsPoll();
  stopChatSync();
  await createNewTerminal(
    accountId,
    true,
    buildResumeCommand(sessionId, accountById(accountId)),
    providerAgentId(accountProvider(accountById(accountId))),
    sessionId,
    environmentPath,
  );
};

// Reprise dans le compte D'ORIGINE : on relance le fichier rollout HEAD (le
// plus recent de la chaine) via son `rolloutId`, non ambigu.
const resumeDiscussion = async (discussion: DiscussionSummary) => {
  try {
    const folderPath = await restoreDiscussionFolder(discussion);
    await resumeSessionInTerminal(
      discussion.accountId,
      discussion.rolloutId || discussion.sessionId,
      folderPath,
    );
  } catch (error) {
    statusText = `Impossible de restaurer l'environnement de la discussion : ${String(error)}`;
    render();
  }
};

// Delai (ms) avant d'injecter le transcript dans une session inter-provider
// fraichement lancee, le temps que le CLI cible ait affiche son invite.
const SEED_PASTE_DELAY_MS = 3500;

// Archive la version source APRES que la continuation cible est prete. Elle
// disparait ainsi de l'onglet Discussions, tout en restant recuperable dans le
// dossier d'archive si un retour arriere est necessaire.
const archiveTransferredDiscussion = async (discussion: DiscussionSummary): Promise<number> => {
  const result = await invoke<{ count?: number }>("delete_discussion", {
    accountId: discussion.accountId,
    // sessionId (identite logique) archive aussi tous les anciens forks Codex.
    sessionId: discussion.sessionId,
    archive: true,
  });
  discussionTargetSel.delete(discussion.sessionId);
  return result?.count ?? 1;
};

const transferredTerminal = (
  session: TerminalSession | null | undefined,
  targetAccountId: string,
) => {
  return session?.accountId === targetAccountId && session.running && session.ptyId !== null
    ? session
    : null;
};

const transferredDiscussionStatus = (
  target: AccountProfile,
  archivedCount: number,
) => {
  const forkNote = archivedCount > 1 ? ` (${archivedCount} anciennes reprises archivees)` : "";
  return `Discussion deplacee vers « ${target.label} »${forkNote} et reprise automatiquement`;
};

// Reprise dans un AUTRE compte = deplacement, pas duplication. Deux cas :
//  - MEME provider Codex : copie FIDELE du rollout HEAD vers le compte cible,
//    reprise native, puis archivage de la chaine source.
//  - INTER-provider (ou impliquant Claude) : export du transcript, injection
//    dans une session NEUVE du provider cible, puis archivage de la source.
//
// Dans les deux cas, la source n'est archivee qu'une fois le terminal cible
// demarre (et, pour un transcript, l'injection reussie). Un echec conserve donc
// l'ancienne discussion dans la liste.
const continueDiscussionWith = async (discussion: DiscussionSummary, targetAccountId: string) => {
  if (discussionBusyId) return;
  if (!settings || !targetAccountId || targetAccountId === discussion.accountId) return;
  const target = accountById(targetAccountId);
  if (!target) return;
  const sourceProvider = discussion.provider ?? accountProvider(accountById(discussion.accountId));
  const targetProvider = accountProvider(target);
  discussionBusyId = discussion.sessionId;
  render();
  try {
    const folderPath = userEnvironmentPath(await restoreDiscussionFolder(discussion));
    if (!folderPath) {
      throw new Error("la discussion n'a pas d'environnement associe");
    }
    if (sourceProvider === "codex" && targetProvider === "codex") {
      const copied = await invoke<DiscussionSummary>("copy_discussion_to_account", {
        sessionId: discussion.rolloutId || discussion.sessionId,
        sourceAccountId: discussion.accountId,
        targetAccountId,
      });
      const resumeId = copied.rolloutId || copied.sessionId;
      if (!isPlausibleSessionId(resumeId)) {
        discussionBusyId = null;
        statusText = "Copie effectuee mais identifiant invalide";
        await refreshDiscussions();
        return;
      }
      const resumed = await createNewTerminal(
        targetAccountId,
        true,
        buildResumeAndContinueCommand(resumeId, target),
        providerAgentId("codex"),
        resumeId,
        folderPath,
      );
      if (!transferredTerminal(resumed, targetAccountId)) {
        discussionBusyId = null;
        statusText = `La nouvelle discussion est disponible dans « ${target.label} », mais le terminal n'a pas demarre. L'ancienne a ete conservee.`;
        render();
        await refreshDiscussions();
        return;
      }
      const archivedCount = await archiveTransferredDiscussion(discussion);
      discussionBusyId = null;
      statusText = transferredDiscussionStatus(target, archivedCount);
      render();
      await refreshDiscussions();
      return;
    }

    // Inter-provider : export du transcript puis amorce dans une session neuve.
    const transcript = await invoke<string>("export_discussion_transcript", {
      accountId: discussion.accountId,
      sessionId: discussion.rolloutId || discussion.sessionId,
    });
    // On lance explicitement le CLI cible (independamment de autoRunCodex) afin
    // de pouvoir injecter le transcript juste apres.
    const started = await createNewTerminal(
      targetAccountId,
      true,
      agentRunCommand(agentById(providerAgentId(targetProvider)), target),
      providerAgentId(targetProvider),
      null,
      folderPath,
    );
    const seeded = transferredTerminal(started, targetAccountId);
    if (!seeded) {
      discussionBusyId = null;
      statusText = "Le terminal cible n'a pas demarre. L'ancienne discussion a ete conservee.";
      render();
      return;
    }
    await seedSessionWithTranscript(seeded, transcript);
    const archivedCount = await archiveTransferredDiscussion(discussion);
    discussionBusyId = null;
    statusText = transferredDiscussionStatus(target, archivedCount);
    render();
    await refreshDiscussions();
  } catch (error) {
    discussionBusyId = null;
    statusText = `Deplacement incomplet : ${String(error)}. L'ancienne discussion a ete conservee si son archivage n'avait pas commence.`;
    render();
  }
};

// Injecte puis soumet le transcript exporte dans une session fraichement
// lancee, apres un court delai (boot du CLI).
const seedSessionWithTranscript = async (
  session: (typeof terminalSessions)[number] | null,
  transcript: string,
) => {
  if (!session) throw new Error("Terminal cible introuvable");
  await sleep(SEED_PASTE_DELAY_MS);
  if (session.ptyId === null || !session.running) {
    throw new Error("Le terminal cible s'est ferme avant l'injection du transcript");
  }
  await invoke("write_terminal", {
    id: session.ptyId,
    data: `\x1b[200~${transcript}\x1b[201~\r`,
  });
};

const discussionHasRunningTurn = (discussion: DiscussionSummary): boolean =>
  (chatDiscussion?.sessionId === discussion.sessionId && chatTurn?.status === "running") ||
  expertChatPanes.some(
    (pane) =>
      pane.discussion?.sessionId === discussion.sessionId && pane.turn?.status === "running",
  );

// Deplacement persistant utilise par le drag-and-drop de la barre laterale.
// Le backend reecrit le cwd (et relocalise la session Claude si necessaire),
// puis renvoie le resume a jour pour les chats deja ouverts.
const moveDiscussionToWorkspace = async (
  discussion: DiscussionSummary,
  workspace: WorkspaceProfile,
) => {
  if (discussionBusyId) return;
  if (discussionHasRunningTurn(discussion)) {
    statusText = "Arretez la reponse en cours avant de deplacer cette conversation";
    render();
    return;
  }
  if (
    discussionFolderPath(discussion) &&
    normalizeWorkspacePath(discussionFolderPath(discussion)!) === normalizeWorkspacePath(workspace.path)
  ) {
    statusText = `La conversation est deja dans ${workspace.label}`;
    return;
  }

  discussionBusyId = discussion.sessionId;
  statusText = `Deplacement vers ${workspace.label}…`;
  render();

  try {
    const moved = await invoke<DiscussionSummary>("move_discussion", {
      accountId: discussion.accountId,
      sessionId: discussion.sessionId,
      workspacePath: workspace.path,
    });
    moved.folderPath = workspace.path;
    Object.assign(discussion, moved);
    if (chatDiscussion?.sessionId === moved.sessionId) {
      Object.assign(chatDiscussion, moved);
    }
    expertChatPanes.forEach((pane) => {
      if (pane.discussion?.sessionId === moved.sessionId) {
        Object.assign(pane.discussion, moved);
        pane.pendingWorkspace = workspace.path;
      }
    });
    discussionBusyId = null;
    statusText = `Conversation deplacee vers ${workspace.label}`;
    await refreshDiscussions();
    render();
  } catch (error) {
    discussionBusyId = null;
    statusText = `Deplacement impossible : ${String(error)}`;
    render();
  }
};

const discussionMatchesAnyId = (
  discussion: DiscussionSummary | null | undefined,
  ids: ReadonlySet<string>,
): boolean => !!discussion && (ids.has(discussion.sessionId) || ids.has(discussion.rolloutId));

const removeArchivedDiscussionFromUi = (ids: ReadonlySet<string>) => {
  ids.forEach((id) => discussionTargetSel.delete(id));
  const closedExpertPanes = expertChatPanes.filter((pane) =>
    discussionMatchesAnyId(pane.discussion, ids),
  );
  closedExpertPanes.forEach((pane) => {
    stopExpertChatSync(pane);
    stopExpertChatTurnPoll(pane);
  });
  expertChatPanes = expertChatPanes.filter(
    (pane) => !discussionMatchesAnyId(pane.discussion, ids),
  );
  if (expertChatsRestored && !expertChatPanes.length) expertChatPanes.push(createExpertChatPane());
  if (closedExpertPanes.some((pane) => pane.key === activeExpertChatKey)) {
    activeExpertChatKey = expertChatPanes[0]?.key ?? null;
  }
  reconcileExpertChatPage();
  if (closedExpertPanes.length) persistExpertChats();
  if (discussionMatchesAnyId(chatDiscussion, ids)) {
    chatDiscussion = null;
    chatMessages = [];
    chatTurn = null;
    chatError = null;
    chatLoading = false;
    chatTruncated = false;
  }
};

const archiveDiscussionById = async (
  accountId: string,
  archiveId: string,
  relatedIds: readonly string[] = [],
): Promise<number> => {
  const result = await invoke<{ count?: number }>("delete_discussion", {
    accountId,
    sessionId: archiveId,
    archive: true,
  });
  removeArchivedDiscussionFromUi(new Set([archiveId, ...relatedIds]));
  return result?.count ?? 1;
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
    const count = await archiveDiscussionById(
      discussion.accountId,
      discussion.sessionId,
      [discussion.rolloutId],
    );
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

// --- Vue conversation interactive -------------------------------------------
// Le provider tourne en arriere-plan, sans TUI visible. Son JSONL reste la
// source de verite : desktop, web et Android voient donc le meme fil.

const chatSelectedAccount = (): AccountProfile | null => {
  const preferred = chatDiscussion?.accountId ?? chatAccountId ?? settings?.defaultAccountId;
  return accountById(preferred) ?? settings?.accounts[0] ?? null;
};

const quotaSuggestionFor = (
  turn: ChatTurnSnapshot | null,
  discussion: DiscussionSummary | null,
): ChatQuotaSuggestion | null => {
  if (
    !turn ||
    turn.status !== "failed" ||
    !isQuotaExhaustionError(turn.error) ||
    !discussion ||
    !settings
  ) {
    return null;
  }

  const current = accountById(turn.accountId);
  if (!current) return null;
  const provider = accountProvider(current);
  const eligibleAccountIds = settings.accounts
    .filter(
      (account) => account.id !== current.id && accountProvider(account) === provider,
    )
    .map((account) => account.id);
  const best = bestQuotaAccount(limitStatus, current.id, eligibleAccountIds);
  if (!best) return null;

  return {
    accountId: best.account.id,
    accountLabel: best.account.label,
    remainingPercent: best.remainingPercent,
    busy: discussionBusyId === discussion.sessionId,
  };
};

let quotaAlternativeRefresh: Promise<void> | null = null;
const refreshQuotaAlternatives = () => {
  if (quotaAlternativeRefresh) return;
  quotaAlternativeRefresh = refreshLimitStatus(true).finally(() => {
    quotaAlternativeRefresh = null;
    if (activeView !== "chat") return;
    expertChatPanes
      .filter((pane) => isQuotaExhaustionError(pane.turn?.error))
      .forEach((pane) => refreshExpertChatPane(pane));
  });
};

const readChatPreferences = (account: AccountProfile, root: ParentNode = document) => {
  const provider = accountProvider(account);
  const previousModel = accountModel(account);
  const previousReasoningEffort = accountReasoningEffort(account);
  const model =
    root.querySelector<HTMLInputElement>("[data-chat-control='model'], #chatModel")?.value.trim() || previousModel;
  const reasoningEffort =
    provider === "codex"
      ? reasoningEffortForChatModel(
          account,
          model,
          root.querySelector<HTMLSelectElement>("[data-chat-control='reasoning-effort'], #chatReasoningEffort")?.value ??
            previousReasoningEffort,
        )
      : null;

  if (model.length > 160 || /\s/.test(model)) {
    return {
      model,
      reasoningEffort,
      changed: false,
      error: "Le nom du modele doit faire 160 caracteres maximum et ne contenir aucun espace",
    };
  }

  account.model = model;
  if (reasoningEffort) account.reasoningEffort = reasoningEffort;

  return {
    model,
    reasoningEffort,
    changed:
      model !== previousModel ||
      (provider === "codex" && reasoningEffort !== previousReasoningEffort),
    error: null,
  };
};

// Les controles du chat deviennent aussi les valeurs par defaut du compte.
// Les sauvegardes sont serialisees pour qu'un changement rapide de
// modele puis d'intensite ne puisse pas s'ecraser dans settings.json.
const persistChatPreferences = (accountId: string) => {
  chatPreferencesSave = chatPreferencesSave
    .catch(() => undefined)
    .then(async () => {
      if (!settings) return;
      await invoke<AppSettings>("save_settings", { settings });
      const account = accountById(accountId);
      if (account) await provisionAccountHome(account);
    })
    .catch((error) => {
      statusText = `Preferences du chat non enregistrees : ${String(error)}`;
    });
};

const chatPanelModel = (): ChatPanelModel => {
  const discussion = chatDiscussion;
  const account = chatSelectedAccount();
  const provider = accountProvider(account);
  const selectedModel = accountModel(account);
  const catalog = account ? chatModelCatalogs.get(account.id) : undefined;
  const workspace =
    discussionFolderPath(discussion) ?? pendingChatWorkspace ?? currentWorkspace() ?? account?.projectDir ?? null;
  const metaParts = discussion
    ? [
        discussion.accountLabel,
        workspace ? displayProjectDir(workspace) : "",
        `${chatMessages.length || discussion.messageCount} message(s)`,
      ].filter(Boolean)
    : [account?.label ?? "Choisissez un compte", workspace ? displayProjectDir(workspace) : "Environnement a choisir"];
  return {
    title: discussion?.title?.trim() || "Nouvelle conversation",
    subtitle: metaParts.join(" \u00b7 "),
    providerLabel: providerLabel(accountProvider(account)),
    loading: chatLoading,
    error: chatError,
    truncated: chatTruncated,
    syncState: discussion ? chatSyncState : "closed",
    messages: chatMessages,
    activities: chatTurn?.activities ?? [],
    turnStatus: chatTurn?.status ?? "idle",
    turnError: chatTurn?.status === "failed" ? (chatTurn.error ?? "La reponse a echoue") : null,
    quotaSuggestion: quotaSuggestionFor(chatTurn, discussion),
    accounts: (settings?.accounts ?? []).map((candidate) => ({
      id: candidate.id,
      label: candidate.label,
      providerLabel: providerLabel(accountProvider(candidate)),
      model: accountModel(candidate),
    })),
    selectedAccountId: account?.id ?? "",
    selectedModel,
    modelSuggestions:
      provider === "claude"
        ? CLAUDE_MODEL_SUGGESTIONS
        : catalog?.map((model) => model.id) ?? CODEX_MODEL_SUGGESTIONS,
    selectedReasoningEffort: reasoningEffortForChatModel(
      account,
      selectedModel,
      accountReasoningEffort(account),
    ),
    reasoningEffortOptions: chatReasoningEffortOptions(account, selectedModel),
    supportsReasoningEffort: provider === "codex",
    mode: chatMode,
    draft: chatDraft,
    newConversation: !discussion,
    workspaceLabel: workspace ? displayProjectDir(workspace) : "Environnement",
    historyOpen: chatHistoryOpen,
  };
};

const refreshChatSyncIndicator = () => {
  const indicator = document.querySelector<HTMLSpanElement>("#chatSync");
  if (!indicator) return;
  indicator.className = `chat-sync chat-sync--${chatSyncState}`;
  const label = indicator.querySelector<HTMLElement>("[data-chat-sync-label]");
  if (label) label.textContent = chatSyncLabel(chatSyncState);
};

const chatFeedMaxScrollTop = (feed: HTMLElement) =>
  Math.max(0, feed.scrollHeight - feed.clientHeight);

const chatFeedIsAtBottom = (feed: HTMLElement) =>
  chatFeedMaxScrollTop(feed) - feed.scrollTop <= CHAT_SCROLL_BOTTOM_EPSILON;

const rememberChatFeedScroll = (feed: HTMLElement) => {
  chatScrollTop = feed.scrollTop;
  chatFollowLatest = chatFeedIsAtBottom(feed);
};

const captureChatFeedScroll = () => {
  if (skipNextChatScrollCapture) {
    skipNextChatScrollCapture = false;
    return;
  }
  const feed = document.querySelector<HTMLDivElement>("#chatFeed");
  if (feed) rememberChatFeedScroll(feed);
};

const restoreChatFeedScroll = (feed: HTMLElement | null) => {
  if (!feed) return;
  const maxScrollTop = chatFeedMaxScrollTop(feed);
  const target = chatFollowLatest
    ? maxScrollTop
    : Math.min(Math.max(0, chatScrollTop), maxScrollTop);
  feed.scrollTop = target;
  chatScrollTop = target;
  if (maxScrollTop <= CHAT_SCROLL_BOTTOM_EPSILON) chatFollowLatest = true;
};

const resetChatFeedScroll = () => {
  chatFollowLatest = true;
  chatScrollTop = 0;
  // Le DOM contient encore l'ancien chat jusqu'au prochain render : ne pas
  // capturer sa position apres avoir demande la remise a zero.
  skipNextChatScrollCapture = true;
};

const bindChatFeedScroll = (feed: HTMLDivElement) => {
  feed.addEventListener("scroll", () => rememberChatFeedScroll(feed), { passive: true });

  // Le listener scroll arrive apres le geste. On desactive donc le suivi des le
  // debut d'une remontee afin qu'un tick de streaming concurrent ne l'annule pas.
  feed.addEventListener(
    "wheel",
    (event) => {
      if (event.deltaY < 0 && feed.scrollTop > 0) {
        chatFollowLatest = false;
        chatScrollTop = feed.scrollTop;
      }
    },
    { passive: true },
  );

  let lastTouchY: number | null = null;
  feed.addEventListener(
    "touchstart",
    (event) => {
      lastTouchY = event.touches[0]?.clientY ?? null;
    },
    { passive: true },
  );
  feed.addEventListener(
    "touchmove",
    (event) => {
      const touchY = event.touches[0]?.clientY ?? null;
      if (touchY !== null && lastTouchY !== null && touchY > lastTouchY && feed.scrollTop > 0) {
        chatFollowLatest = false;
        chatScrollTop = feed.scrollTop;
      }
      lastTouchY = touchY;
    },
    { passive: true },
  );
  feed.addEventListener("touchend", () => {
    lastTouchY = null;
  }, { passive: true });
  feed.addEventListener("touchcancel", () => {
    lastTouchY = null;
  }, { passive: true });
};

// Patch CIBLE du fil (pattern #roomFeed) : pas de re-render global. Le suivi
// reste actif jusqu'a une remontee explicite, puis reprend quand le bas est
// atteint. La position absolue est conservee pendant le remplacement du HTML.
const refreshChatFeed = () => {
  const feed = document.querySelector<HTMLDivElement>("#chatFeed");
  if (!feed) {
    render();
    return;
  }
  chatScrollTop = feed.scrollTop;
  feed.innerHTML = renderChatFeedInner(chatPanelModel());
  const subtitle = document.querySelector<HTMLSpanElement>("#chatSubtitle");
  if (subtitle) subtitle.textContent = chatPanelModel().subtitle;
  const historyCount = document.querySelector<HTMLElement>("#chatHistoryToggle small");
  if (historyCount) {
    historyCount.textContent = String(chatMessages.filter((message) => message.role === "user").length);
  }
  refreshChatSyncIndicator();
  createIcons({ icons: lucideIcons });
  restoreChatFeedScroll(feed);
};

const stopChatTurnPoll = () => {
  if (chatTurnPoll !== null) {
    clearInterval(chatTurnPoll);
    chatTurnPoll = null;
  }
  chatTurnPollInFlight = false;
};

const findDiscussionByRollout = (sessionId: string) =>
  allDiscussions().find(
    (discussion) => discussion.sessionId === sessionId || discussion.rolloutId === sessionId,
  ) ?? null;

const attachCreatedChat = async (sessionId: string): Promise<boolean> => {
  if (chatDiscussion) return true;
  let discussion = findDiscussionByRollout(sessionId);
  if (!discussion) {
    await refreshDiscussions();
    discussion = findDiscussionByRollout(sessionId);
  }
  if (!discussion) return false;

  chatDiscussion = discussion;
  chatAccountId = discussion.accountId;
  void loadChatModelCatalog(chatAccountId);
  chatLoading = false;
  chatError = null;
  startChatSync();
  void loadChatTranscript();
  return true;
};

const applyChatTurnSnapshot = async (snapshot: ChatTurnSnapshot) => {
  const pane = expertChatPanes.find(
    (candidate) =>
      candidate.turn?.status === "running" &&
      (candidate.turn.id === 0 || candidate.turn.id === snapshot.id) &&
      candidate.turn.accountId === snapshot.accountId,
  ) ?? activeExpertChatPane();
  if (pane?.turn?.status === "running") {
    await applyExpertChatTurnSnapshot(pane, snapshot);
    return;
  }
  if (chatTurn && chatTurn.id !== 0 && snapshot.id !== chatTurn.id) return;
  const previousStatus = chatTurn?.status;
  chatTurn = snapshot;
  const quotaExhausted =
    snapshot.status === "failed" &&
    previousStatus !== "failed" &&
    isQuotaExhaustionError(snapshot.error);
  const attached = snapshot.sessionId ? await attachCreatedChat(snapshot.sessionId) : !!chatDiscussion;

  if (snapshot.status === "completed") {
    statusText = "Reponse terminee";
    if (attached) {
      await loadChatTranscript();
      stopChatTurnPoll();
    }
  } else if (snapshot.status === "failed") {
    statusText = snapshot.error || "La reponse a echoue";
    stopChatTurnPoll();
  } else if (snapshot.status === "cancelled") {
    statusText = "Reponse arretee";
    stopChatTurnPoll();
  } else {
    statusText = `${chatPanelModel().providerLabel} travaille…`;
  }

  if (activeView === "chat") {
    if (previousStatus !== snapshot.status) render();
    else refreshChatFeed();
  }
  if (quotaExhausted) refreshQuotaAlternatives();
};

const pollChatTurn = async () => {
  if (!chatTurn || chatTurn.id === 0 || chatTurnPollInFlight) return;
  chatTurnPollInFlight = true;
  try {
    const snapshot = await invoke<ChatTurnSnapshot>("chat_turn_status", { id: chatTurn.id });
    await applyChatTurnSnapshot(snapshot);
  } catch (error) {
    statusText = `Suivi de la reponse : ${String(error)}`;
  } finally {
    chatTurnPollInFlight = false;
  }
};

const startChatTurnPoll = () => {
  stopChatTurnPoll();
  chatTurnPoll = window.setInterval(() => void pollChatTurn(), 550);
};

const sendChatMessage = async () => {
  if (chatTurn?.status === "running") return;
  const input = document.querySelector<HTMLTextAreaElement>("#chatPrompt");
  const prompt = (input?.value ?? chatDraft).trim();
  const account = chatSelectedAccount();
  if (!prompt || !account) {
    statusText = account ? "Ecrivez un message" : "Ajoutez d'abord un compte agent";
    return;
  }
  const preferences = readChatPreferences(account);
  if (preferences.error) {
    const modelInput = document.querySelector<HTMLInputElement>("#chatModel");
    modelInput?.setCustomValidity(preferences.error);
    modelInput?.reportValidity();
    statusText = preferences.error;
    return;
  }
  if (preferences.changed) persistChatPreferences(account.id);

  chatDraft = "";
  chatError = null;
  chatMessages = [
    ...chatMessages,
    { role: "user", text: prompt, timestamp: Math.floor(Date.now() / 1000) },
  ];
  chatTurn = {
    id: 0,
    accountId: account.id,
    sessionId: chatDiscussion?.rolloutId ?? chatDiscussion?.sessionId ?? null,
    status: "running",
    startedAt: Math.floor(Date.now() / 1000),
    finishedAt: null,
    error: null,
    activities: [
      {
        id: "preparing",
        kind: "think",
        label: `${providerLabel(accountProvider(account))} prepare la reponse`,
        detail: null,
        status: "running",
      },
    ],
  };
  statusText = `${providerLabel(accountProvider(account))} travaille…`;
  resetChatFeedScroll();
  render();

  try {
    const snapshot = await invoke<ChatTurnSnapshot>("start_chat_turn", {
      accountId: account.id,
      sessionId: chatDiscussion?.rolloutId ?? chatDiscussion?.sessionId ?? null,
      prompt,
      projectDir:
        discussionFolderPath(chatDiscussion) ?? pendingChatWorkspace ?? currentWorkspace() ?? account.projectDir ?? null,
      mode: chatMode,
      model: preferences.model,
      reasoningEffort: preferences.reasoningEffort,
    });
    const pane = expertChatPanes.find(
      (candidate) =>
        candidate.turn?.status === "running" &&
        candidate.turn.id === 0 &&
        candidate.turn.accountId === snapshot.accountId,
    );
    if (pane) {
      pane.turn = snapshot;
      startExpertChatTurnPoll(pane);
      await applyExpertChatTurnSnapshot(pane, snapshot);
      return;
    }
    chatTurn = snapshot;
    startChatTurnPoll();
    await applyChatTurnSnapshot(snapshot);
  } catch (error) {
    const pane = expertChatPanes.find(
      (candidate) =>
        candidate.turn?.status === "running" &&
        candidate.turn.id === 0 &&
        candidate.turn.accountId === account.id,
    );
    if (pane) {
      pane.turn = {
        ...pane.turn!,
        status: "failed",
        finishedAt: Math.floor(Date.now() / 1000),
        error: String(error),
      };
      statusText = String(error);
      refreshExpertChatPane(pane);
      if (isQuotaExhaustionError(String(error))) refreshQuotaAlternatives();
      return;
    }
    chatTurn = {
      ...chatTurn,
      id: 0,
      status: "failed",
      finishedAt: Math.floor(Date.now() / 1000),
      error: String(error),
    } as ChatTurnSnapshot;
    statusText = String(error);
    render();
    if (isQuotaExhaustionError(String(error))) refreshQuotaAlternatives();
  }
};

const closeWorkspace = async (
  workspace: WorkspaceProfile,
  removedFromEnvironmentMenu = false,
): Promise<void> => {
  if (!settings || workspaceClosingId) return;
  const id = workspaceIdForPath(workspace.path);
  const terminalCount = terminalSessions.filter(
    (session) => session.folderPath && workspaceIdForPath(session.folderPath) === id,
  ).length;

  workspaceClosingId = id;
  const previousWorkspaces = settings.workspaces;
  const previousClosedIds = settings.closedWorkspaceIds;
  const update = closeWorkspaceRegistry(
    settings.workspaces ?? [],
    settings.closedWorkspaceIds ?? [],
    workspace.path,
  );
  settings.workspaces = update.workspaces;
  settings.closedWorkspaceIds = update.closedWorkspaceIds;

  try {
    settings = await invoke<AppSettings>("save_settings", { settings });
  } catch (error) {
    settings.workspaces = previousWorkspaces;
    settings.closedWorkspaceIds = previousClosedIds;
    workspaceClosingId = null;
    statusText = `Fermeture impossible : ${String(error)}`;
    render();
    return;
  }

  forgetWorkspace(workspace.path);
  const activePath = currentWorkspace();
  const closedActiveWorkspace = !!activePath && workspaceIdForPath(activePath) === id;
  if (closedActiveWorkspace) {
    setCurrentWorkspace(null);
    workspaceLiveGraphOpen = false;
    roomStatus = null;
    roomMessages = [];
    stopRoomPoll();
  }
  if (terminalFolderFilter && workspaceIdForPath(terminalFolderFilter) === id) {
    terminalFolderFilter = null;
  }
  if (activeChatWorkspaceFilter() === id) setChatWorkspaceFilter(WORKSPACE_ALL);
  if (pendingChatWorkspace && workspaceIdForPath(pendingChatWorkspace) === id) {
    pendingChatWorkspace = null;
  }
  if (newTerminalWorkspacePath && workspaceIdForPath(newTerminalWorkspacePath) === id) {
    newTerminalWorkspacePath = null;
  }
  let expertChatsChanged = false;
  expertChatPanes.forEach((pane) => {
    if (
      !pane.discussion &&
      pane.pendingWorkspace &&
      workspaceIdForPath(pane.pendingWorkspace) === id
    ) {
      pane.pendingWorkspace = null;
      expertChatsChanged = true;
    }
  });
  if (expertChatsChanged) persistExpertChats();

  workspaceClosingId = null;
  const action = removedFromEnvironmentMenu ? "supprime de Switch" : "ferme";
  statusText = terminalCount
    ? `Environnement « ${workspace.label} » ${action} · ${terminalCount} terminal${terminalCount > 1 ? "s restent" : " reste"} ouvert${terminalCount > 1 ? "s" : ""}`
    : `Environnement « ${workspace.label} » ${action}`;
  render();
};

const stopCurrentChatTurn = async () => {
  if (!chatTurn || chatTurn.status !== "running") return;
  if (chatTurn.id === 0) {
    chatTurn = { ...chatTurn, status: "cancelled" };
    stopChatTurnPoll();
    render();
    return;
  }
  try {
    await applyChatTurnSnapshot(
      await invoke<ChatTurnSnapshot>("stop_chat_turn", { id: chatTurn.id }),
    );
  } catch (error) {
    statusText = String(error);
  }
};

const openNewChat = () => {
  openNewChatModal();
};

const sameChatMessages = (left: ChatMessage[], right: ChatMessage[]) =>
  left.length === right.length &&
  left.every(
    (message, index) =>
      message.role === right[index]?.role &&
      message.timestamp === right[index]?.timestamp &&
      message.text === right[index]?.text,
  );

const applyChatTranscript = (
  discussion: DiscussionSummary,
  transcript: DiscussionTranscriptView,
) => {
  if (chatDiscussion !== discussion) return;
  const wasLoading = chatLoading;
  const changed = !sameChatMessages(chatMessages, transcript.messages);
  const truncationChanged = chatTruncated !== transcript.truncated;
  chatMessages = transcript.messages;
  chatTruncated = transcript.truncated;
  chatLoading = false;
  chatError = null;
  if (activeView === "chat" && (changed || truncationChanged || wasLoading)) {
    if (chatHistoryOpen && changed) render();
    else refreshChatFeed();
  } else if (activeView === "chat") {
    refreshChatSyncIndicator();
  }
};

const loadChatTranscript = async () => {
  const discussion = chatDiscussion;
  if (!discussion || chatLoadInFlight) return;
  chatLoadInFlight = true;
  if (chatMessages.length === 0) {
    chatLoading = true;
    chatError = null;
  }
  try {
    const transcript = await invoke<DiscussionTranscriptView>("get_discussion_transcript", {
      accountId: discussion.accountId,
      // rolloutId = fichier HEAD : l'historique le plus complet a travers les
      // reprises (cf. collapse_forks cote backend).
      sessionId: discussion.rolloutId || discussion.sessionId,
    });
    applyChatTranscript(discussion, transcript);
  } catch (error) {
    if (chatDiscussion !== discussion) return;
    chatLoading = false;
    const empty = chatMessages.length === 0;
    if (empty) chatError = String(error);
    statusText = `Conversation : ${String(error)}`;
    if (activeView === "chat") {
      if (empty) refreshChatFeed();
      else refreshChatSyncIndicator();
    }
  } finally {
    chatLoadInFlight = false;
  }
};

const stopChatSync = () => {
  chatLiveUnlisten?.();
  chatLiveUnlisten = null;
  if (chatFallbackPoll !== null) {
    clearInterval(chatFallbackPoll);
    chatFallbackPoll = null;
  }
  chatSyncState = "closed";
};

const startChatSync = () => {
  stopChatSync();
  const discussion = chatDiscussion;
  if (!discussion) return;

  if (!isRemoteMode()) {
    chatSyncState = "polling";
    chatFallbackPoll = window.setInterval(() => void loadChatTranscript(), 1000);
    return;
  }

  chatSyncState = "connecting";
  const watchedSessionId = discussion.rolloutId || discussion.sessionId;
  chatLiveUnlisten = subscribeDiscussionUpdates(
    { accountId: discussion.accountId, sessionId: watchedSessionId },
    (message: DiscussionStreamMessage) => {
      if (chatDiscussion !== discussion) return;
      if (
        message.type === "transcript" &&
        message.accountId === discussion.accountId &&
        message.sessionId === watchedSessionId
      ) {
        applyChatTranscript(discussion, message.transcript as DiscussionTranscriptView);
      } else if (message.type === "error") {
        chatLoading = false;
        const empty = chatMessages.length === 0;
        if (empty) chatError = message.message;
        statusText = `Conversation : ${message.message}`;
        if (activeView === "chat") {
          if (empty) refreshChatFeed();
          else refreshChatSyncIndicator();
        }
      }
    },
    (state: RealtimeConnectionState) => {
      if (chatDiscussion !== discussion) return;
      chatSyncState = state;
      if (activeView === "chat") refreshChatSyncIndicator();
    },
  );
  // Si un reverse-proxy refuse les WebSockets, le REST garde la conversation
  // vivante pendant les tentatives de reconnexion.
  chatFallbackPoll = window.setInterval(() => {
    if (chatSyncState !== "live") void loadChatTranscript();
  }, 2000);
};

const openDiscussionChat = async (discussion: DiscussionSummary) => {
  try {
    await restoreDiscussionFolder(discussion);
    openDiscussionInExpert(discussion);
  } catch (error) {
    statusText = `Environnement de la discussion non restaure : ${String(error)}`;
    render();
  }
};

// --- Grille de chats persistants, indépendants et paginés -------------------

const createExpertChatPane = (
  discussion: DiscussionSummary | null = null,
  persisted: Partial<PersistedExpertChatPane> = {},
): ExpertChatPane => {
  const capturedWorkspace = userEnvironmentPath(persisted.pendingWorkspace);
  if (
    discussion &&
    capturedWorkspace &&
    isEphemeralChatWorkspacePath(discussion.cwd)
  ) {
    discussion.folderPath = capturedWorkspace;
  }

  return {
    key: persisted.key || uid("chat-pane"),
    discussion,
    messages: [],
    loading: !!discussion,
    error: null,
    truncated: false,
    syncState: "closed",
    liveUnlisten: null,
    fallbackPoll: null,
    loadInFlight: false,
    turn: null,
    turnPoll: null,
    turnPollInFlight: false,
    draft: persisted.draft ?? "",
    mode:
      persisted.mode === "plan" || persisted.mode === "ask" ? persisted.mode : "build",
    accountId:
      discussion?.accountId ??
      persisted.accountId ??
      selectedAccountId ??
      settings?.defaultAccountId ??
      settings?.accounts[0]?.id ??
      null,
    historyOpen: false,
    pendingWorkspace:
      discussionFolderPath(discussion) ?? capturedWorkspace ?? currentWorkspace(),
    followLatest: true,
    scrollTop: 0,
  };
};

const expertChatPaneEnvironmentPath = (pane: ExpertChatPane): string | null =>
  userEnvironmentPath(
    discussionFolderPath(pane.discussion) ?? pane.pendingWorkspace,
  );

const expertChatPanesForCurrentEnvironment = (): ExpertChatPane[] => {
  const environmentPath = userEnvironmentPath(currentWorkspace());
  if (!environmentPath) return [];
  const environmentId = workspaceIdForPath(environmentPath);
  return expertChatPanes.filter((pane) => {
    const panePath = expertChatPaneEnvironmentPath(pane);
    return !!panePath && workspaceIdForPath(panePath) === environmentId;
  });
};

const activeExpertChatPane = (): ExpertChatPane | null =>
  expertChatPanesForCurrentEnvironment().find((pane) => pane.key === activeExpertChatKey) ??
  expertChatPanesForCurrentEnvironment()[0] ??
  null;

const expertChatPageTotal = (): number =>
  expertChatPageCount(expertChatPanesForCurrentEnvironment().length, expertChatsPerPage);

const visibleExpertChatPanes = (): ExpertChatPane[] =>
  expertChatsOnPage(
    expertChatPanesForCurrentEnvironment(),
    expertChatPage,
    expertChatsPerPage,
  );

const expertChatStatusText = (): string => {
  const count = expertChatPanesForCurrentEnvironment().length;
  const totalPages = expertChatPageTotal();
  return `${count} chat${count > 1 ? "s" : ""} dans cet environnement · page ${expertChatPage + 1}/${totalPages}`;
};

const moveExpertChatPageToPane = (pane: ExpertChatPane | null) => {
  const panes = expertChatPanesForCurrentEnvironment();
  const index = pane ? panes.indexOf(pane) : -1;
  expertChatPage = index >= 0
    ? expertChatPageForIndex(index, expertChatsPerPage)
    : clampExpertChatPage(expertChatPage, panes.length, expertChatsPerPage);
};

const reconcileExpertChatPage = () => {
  const active = activeExpertChatPane();
  if (active) {
    activeExpertChatKey = active.key;
    moveExpertChatPageToPane(active);
    return;
  }
  expertChatPage = clampExpertChatPage(
    expertChatPage,
    expertChatPanesForCurrentEnvironment().length,
    expertChatsPerPage,
  );
};

const expertChatPaneRoot = (pane: ExpertChatPane): HTMLElement | null =>
  document.getElementById(`chatPanel-${pane.key.replace(/[^a-zA-Z0-9_-]/g, "-")}`);

const expertChatSelectedAccount = (pane: ExpertChatPane): AccountProfile | null => {
  const preferred = pane.discussion?.accountId ?? pane.accountId ?? settings?.defaultAccountId;
  return accountById(preferred) ?? settings?.accounts[0] ?? null;
};

const expertChatPanelModel = (pane: ExpertChatPane): ChatPanelModel => {
  const discussion = pane.discussion;
  const account = expertChatSelectedAccount(pane);
  const provider = accountProvider(account);
  const selectedModel = accountModel(account);
  const catalog = account ? chatModelCatalogs.get(account.id) : undefined;
  const workspace =
    discussionFolderPath(discussion) ?? pane.pendingWorkspace ?? currentWorkspace() ?? account?.projectDir ?? null;
  const metaParts = discussion
    ? [
        discussion.accountLabel,
        workspace ? displayProjectDir(workspace) : "",
        `${pane.messages.length || discussion.messageCount} message(s)`,
      ].filter(Boolean)
    : [account?.label ?? "Choisissez un compte", workspace ? displayProjectDir(workspace) : "Environnement a choisir"];
  return {
    title: discussion?.title?.trim() || "Nouvelle conversation",
    subtitle: metaParts.join(" \u00b7 "),
    providerLabel: providerLabel(provider),
    loading: pane.loading,
    error: pane.error,
    truncated: pane.truncated,
    syncState: discussion ? pane.syncState : "closed",
    messages: pane.messages,
    activities: pane.turn?.activities ?? [],
    turnStatus: pane.turn?.status ?? "idle",
    turnError: pane.turn?.status === "failed" ? (pane.turn.error ?? "La reponse a echoue") : null,
    quotaSuggestion: quotaSuggestionFor(pane.turn, discussion),
    accounts: (settings?.accounts ?? []).map((candidate) => ({
      id: candidate.id,
      label: candidate.label,
      providerLabel: providerLabel(accountProvider(candidate)),
      model: accountModel(candidate),
    })),
    selectedAccountId: account?.id ?? "",
    selectedModel,
    modelSuggestions:
      provider === "claude"
        ? CLAUDE_MODEL_SUGGESTIONS
        : catalog?.map((model) => model.id) ?? CODEX_MODEL_SUGGESTIONS,
    selectedReasoningEffort: reasoningEffortForChatModel(
      account,
      selectedModel,
      accountReasoningEffort(account),
    ),
    reasoningEffortOptions: chatReasoningEffortOptions(account, selectedModel),
    supportsReasoningEffort: provider === "codex",
    mode: pane.mode,
    draft: pane.draft,
    newConversation: !discussion,
    workspaceLabel: workspace ? displayProjectDir(workspace) : "Environnement",
    historyOpen: pane.historyOpen,
  };
};

const persistExpertChats = () => {
  // Ne pas ecraser l'etat local par une liste vide avant sa restauration.
  if (!expertChatsRestored && expertChatPanes.length === 0) return;
  const state: PersistedExpertChats = {
    v: 1,
    activeKey: activeExpertChatKey,
    panes: expertChatPanes.map((pane) => ({
      key: pane.key,
      sessionId: pane.discussion?.sessionId ?? null,
      accountId: pane.accountId,
      draft: pane.draft,
      mode: pane.mode,
      pendingWorkspace: pane.pendingWorkspace,
    })),
  };
  localStorage.setItem(EXPERT_OPEN_CHATS_STORAGE_KEY, JSON.stringify(state));
};

const restoreExpertChats = () => {
  if (expertChatsRestored) return;
  expertChatsRestored = true;
  let persisted: PersistedExpertChats | null = null;
  try {
    const parsed = JSON.parse(localStorage.getItem(EXPERT_OPEN_CHATS_STORAGE_KEY) ?? "null") as Partial<PersistedExpertChats> | null;
    if (parsed?.v === 1 && Array.isArray(parsed.panes)) {
      persisted = parsed as PersistedExpertChats;
    }
  } catch {
    localStorage.removeItem(EXPERT_OPEN_CHATS_STORAGE_KEY);
  }

  expertChatPanes = (persisted?.panes ?? [])
    .flatMap((record) => {
      if (!record || typeof record.key !== "string") return [];
      const discussion = record.sessionId ? findDiscussion(record.sessionId) : null;
      if (record.sessionId && !discussion) return [];
      return [createExpertChatPane(discussion, record)];
    });
  if (!expertChatPanes.length) expertChatPanes = [createExpertChatPane()];
  activeExpertChatKey =
    (persisted?.activeKey && expertChatPanes.some((pane) => pane.key === persisted.activeKey)
      ? persisted.activeKey
      : expertChatPanes[0]?.key) ?? null;
  reconcileExpertChatPage();
  persistExpertChats();
};

const captureExpertChatScroll = (pane: ExpertChatPane, root = expertChatPaneRoot(pane)) => {
  const feed = root?.querySelector<HTMLElement>("[data-chat-control='feed']");
  if (!feed) return;
  pane.scrollTop = feed.scrollTop;
  pane.followLatest = chatFeedIsAtBottom(feed);
};

const restoreExpertChatScroll = (pane: ExpertChatPane, root = expertChatPaneRoot(pane)) => {
  const feed = root?.querySelector<HTMLElement>("[data-chat-control='feed']");
  if (!feed) return;
  const maxScrollTop = chatFeedMaxScrollTop(feed);
  const target = pane.followLatest
    ? maxScrollTop
    : Math.min(Math.max(0, pane.scrollTop), maxScrollTop);
  feed.scrollTop = target;
  pane.scrollTop = target;
  if (maxScrollTop <= CHAT_SCROLL_BOTTOM_EPSILON) pane.followLatest = true;
};

const captureAllExpertChatScroll = () => expertChatPanes.forEach((pane) => captureExpertChatScroll(pane));

const renderExpertChatPane = (pane: ExpertChatPane): string =>
  renderChatPanel(expertChatPanelModel(pane), {
    instanceId: pane.key,
    paneIndex: expertChatPanes.indexOf(pane) + 1,
    active: pane.key === activeExpertChatKey,
    compact: true,
    fullscreen: pane.key === expertChatFullscreenKey,
  });

const refreshExpertChatSyncIndicator = (pane: ExpertChatPane) => {
  const indicator = expertChatPaneRoot(pane)?.querySelector<HTMLElement>("[data-chat-control='sync']");
  if (!indicator) return;
  indicator.className = `chat-sync chat-sync--${pane.syncState}`;
  const label = indicator.querySelector<HTMLElement>("[data-chat-sync-label]");
  if (label) label.textContent = chatSyncLabel(pane.syncState);
};

const refreshExpertChatFeed = (pane: ExpertChatPane) => {
  const root = expertChatPaneRoot(pane);
  const feed = root?.querySelector<HTMLElement>("[data-chat-control='feed']");
  if (!root || !feed) return;
  pane.scrollTop = feed.scrollTop;
  const model = expertChatPanelModel(pane);
  feed.innerHTML = renderChatFeedInner(model, pane.key);
  const subtitle = root.querySelector<HTMLElement>("[data-chat-control='subtitle']");
  if (subtitle) subtitle.textContent = model.subtitle;
  const historyCount = root.querySelector<HTMLElement>("[data-chat-action='history-toggle'] small");
  if (historyCount) {
    historyCount.textContent = String(pane.messages.filter((message) => message.role === "user").length);
  }
  refreshExpertChatSyncIndicator(pane);
  createIcons({ icons: lucideIcons });
  restoreExpertChatScroll(pane, root);
};

const refreshExpertChatPane = (pane: ExpertChatPane) => {
  const root = expertChatPaneRoot(pane);
  if (!root) return;
  captureExpertChatScroll(pane, root);
  root.outerHTML = renderExpertChatPane(pane);
  createIcons({ icons: lucideIcons });
  const nextRoot = expertChatPaneRoot(pane);
  if (nextRoot) bindExpertChatPaneUi(pane, nextRoot);
  restoreExpertChatScroll(pane, nextRoot);
};

const stopExpertChatTurnPoll = (pane: ExpertChatPane) => {
  if (pane.turnPoll !== null) {
    clearInterval(pane.turnPoll);
    pane.turnPoll = null;
  }
  pane.turnPollInFlight = false;
};

const stopExpertChatSync = (pane: ExpertChatPane) => {
  pane.liveUnlisten?.();
  pane.liveUnlisten = null;
  if (pane.fallbackPoll !== null) {
    clearInterval(pane.fallbackPoll);
    pane.fallbackPoll = null;
  }
  pane.syncState = "closed";
};

const stopAllExpertChatWork = () => {
  expertChatPanes.forEach((pane) => {
    stopExpertChatSync(pane);
    stopExpertChatTurnPoll(pane);
  });
};

const applyExpertChatTranscript = (
  pane: ExpertChatPane,
  discussion: DiscussionSummary,
  transcript: DiscussionTranscriptView,
) => {
  if (!expertChatPanes.includes(pane) || pane.discussion !== discussion) return;
  const wasLoading = pane.loading;
  const changed = !sameChatMessages(pane.messages, transcript.messages);
  const truncationChanged = pane.truncated !== transcript.truncated;
  pane.messages = transcript.messages;
  pane.truncated = transcript.truncated;
  pane.loading = false;
  pane.error = null;
  if (activeView === "chat" && (changed || truncationChanged || wasLoading)) {
    if (pane.historyOpen && changed) refreshExpertChatPane(pane);
    else refreshExpertChatFeed(pane);
  } else if (activeView === "chat") {
    refreshExpertChatSyncIndicator(pane);
  }
};

const loadExpertChatTranscript = async (pane: ExpertChatPane) => {
  const discussion = pane.discussion;
  if (!discussion || pane.loadInFlight || !expertChatPanes.includes(pane)) return;
  pane.loadInFlight = true;
  if (pane.messages.length === 0) {
    pane.loading = true;
    pane.error = null;
  }
  try {
    const transcript = await invoke<DiscussionTranscriptView>("get_discussion_transcript", {
      accountId: discussion.accountId,
      sessionId: discussion.rolloutId || discussion.sessionId,
    });
    applyExpertChatTranscript(pane, discussion, transcript);
  } catch (error) {
    if (!expertChatPanes.includes(pane) || pane.discussion !== discussion) return;
    pane.loading = false;
    if (pane.messages.length === 0) pane.error = String(error);
    statusText = `Conversation : ${String(error)}`;
    if (activeView === "chat") refreshExpertChatPane(pane);
  } finally {
    pane.loadInFlight = false;
  }
};

const startExpertChatSync = (pane: ExpertChatPane) => {
  stopExpertChatSync(pane);
  const discussion = pane.discussion;
  if (!discussion) return;

  if (!isRemoteMode()) {
    pane.syncState = "polling";
    pane.fallbackPoll = window.setInterval(() => void loadExpertChatTranscript(pane), 1000);
    return;
  }

  pane.syncState = "connecting";
  const watchedSessionId = discussion.rolloutId || discussion.sessionId;
  pane.liveUnlisten = subscribeDiscussionUpdates(
    { accountId: discussion.accountId, sessionId: watchedSessionId },
    (message: DiscussionStreamMessage) => {
      if (!expertChatPanes.includes(pane) || pane.discussion !== discussion) return;
      if (
        message.type === "transcript" &&
        message.accountId === discussion.accountId &&
        message.sessionId === watchedSessionId
      ) {
        applyExpertChatTranscript(pane, discussion, message.transcript as DiscussionTranscriptView);
      } else if (message.type === "error") {
        pane.loading = false;
        if (pane.messages.length === 0) pane.error = message.message;
        statusText = `Conversation : ${message.message}`;
        if (activeView === "chat") refreshExpertChatPane(pane);
      }
    },
    (state: RealtimeConnectionState) => {
      if (!expertChatPanes.includes(pane) || pane.discussion !== discussion) return;
      pane.syncState = state;
      if (activeView === "chat") refreshExpertChatSyncIndicator(pane);
    },
  );
  pane.fallbackPoll = window.setInterval(() => {
    if (pane.syncState !== "live") void loadExpertChatTranscript(pane);
  }, 2000);
};

const attachCreatedExpertChat = async (
  pane: ExpertChatPane,
  sessionId: string,
): Promise<boolean> => {
  if (pane.discussion) return true;
  let discussion = findDiscussionByRollout(sessionId);
  if (!discussion) {
    await refreshDiscussions();
    discussion = findDiscussionByRollout(sessionId);
  }
  if (!discussion || !expertChatPanes.includes(pane)) return false;
  const capturedWorkspace = userEnvironmentPath(pane.pendingWorkspace);
  if (capturedWorkspace) {
    // Le premier snapshot pointe encore vers le worktree physique. Conserver
    // l'environnement capture a la creation empeche le panneau de disparaitre
    // de la grille pendant que le backend restaure le cwd logique du JSONL.
    discussion.folderPath = capturedWorkspace;
    pane.pendingWorkspace = capturedWorkspace;
  }
  pane.discussion = discussion;
  pane.accountId = discussion.accountId;
  pane.loading = false;
  pane.error = null;
  void loadChatModelCatalog(pane.accountId);
  startExpertChatSync(pane);
  persistExpertChats();
  void loadExpertChatTranscript(pane);
  return true;
};

const applyExpertChatTurnSnapshot = async (
  pane: ExpertChatPane,
  snapshot: ChatTurnSnapshot,
) => {
  if (!expertChatPanes.includes(pane)) return;
  if (pane.turn && pane.turn.id !== 0 && snapshot.id !== pane.turn.id) return;
  const previousStatus = pane.turn?.status;
  pane.turn = snapshot;
  const quotaExhausted =
    snapshot.status === "failed" &&
    previousStatus !== "failed" &&
    isQuotaExhaustionError(snapshot.error);
  const attached = snapshot.sessionId
    ? await attachCreatedExpertChat(pane, snapshot.sessionId)
    : !!pane.discussion;

  if (snapshot.status === "completed") {
    statusText = "Reponse terminee";
    if (attached) await loadExpertChatTranscript(pane);
    stopExpertChatTurnPoll(pane);
  } else if (snapshot.status === "failed") {
    statusText = snapshot.error || "La reponse a echoue";
    stopExpertChatTurnPoll(pane);
  } else if (snapshot.status === "cancelled") {
    statusText = "Reponse arretee";
    stopExpertChatTurnPoll(pane);
  } else {
    statusText = `${expertChatPanelModel(pane).providerLabel} travaille…`;
  }

  if (activeView === "chat") {
    if (previousStatus !== snapshot.status) refreshExpertChatPane(pane);
    else refreshExpertChatFeed(pane);
  }
  if (quotaExhausted) refreshQuotaAlternatives();
};

const pollExpertChatTurn = async (pane: ExpertChatPane) => {
  if (!pane.turn || pane.turn.id === 0 || pane.turnPollInFlight || !expertChatPanes.includes(pane)) return;
  pane.turnPollInFlight = true;
  try {
    const snapshot = await invoke<ChatTurnSnapshot>("chat_turn_status", { id: pane.turn.id });
    await applyExpertChatTurnSnapshot(pane, snapshot);
  } catch (error) {
    statusText = `Suivi de la reponse : ${String(error)}`;
  } finally {
    pane.turnPollInFlight = false;
  }
};

const startExpertChatTurnPoll = (pane: ExpertChatPane) => {
  stopExpertChatTurnPoll(pane);
  pane.turnPoll = window.setInterval(() => void pollExpertChatTurn(pane), 550);
};

const sendExpertChatMessage = async (pane: ExpertChatPane, root: HTMLElement) => {
  if (pane.turn?.status === "running") return;
  const input = root.querySelector<HTMLTextAreaElement>("[data-chat-control='prompt']");
  const prompt = (input?.value ?? pane.draft).trim();
  const account = expertChatSelectedAccount(pane);
  if (!prompt || !account) {
    statusText = account ? "Ecrivez un message" : "Ajoutez d'abord un compte agent";
    return;
  }
  const preferences = readChatPreferences(account, root);
  if (preferences.error) {
    const modelInput = root.querySelector<HTMLInputElement>("[data-chat-control='model']");
    modelInput?.setCustomValidity(preferences.error);
    modelInput?.reportValidity();
    statusText = preferences.error;
    return;
  }
  if (preferences.changed) persistChatPreferences(account.id);

  pane.draft = "";
  pane.error = null;
  pane.messages = [
    ...pane.messages,
    { role: "user", text: prompt, timestamp: Math.floor(Date.now() / 1000) },
  ];
  pane.turn = {
    id: 0,
    accountId: account.id,
    sessionId: pane.discussion?.rolloutId ?? pane.discussion?.sessionId ?? null,
    status: "running",
    startedAt: Math.floor(Date.now() / 1000),
    finishedAt: null,
    error: null,
    activities: [
      {
        id: "preparing",
        kind: "think",
        label: `${providerLabel(accountProvider(account))} prepare la reponse`,
        detail: null,
        status: "running",
      },
    ],
  };
  pane.followLatest = true;
  pane.scrollTop = 0;
  statusText = `${providerLabel(accountProvider(account))} travaille…`;
  persistExpertChats();
  refreshExpertChatPane(pane);

  try {
    const snapshot = await invoke<ChatTurnSnapshot>("start_chat_turn", {
      accountId: account.id,
      sessionId: pane.discussion?.rolloutId ?? pane.discussion?.sessionId ?? null,
      prompt,
      projectDir:
        discussionFolderPath(pane.discussion) ?? pane.pendingWorkspace ?? currentWorkspace() ?? account.projectDir ?? null,
      mode: pane.mode,
      model: preferences.model,
      reasoningEffort: preferences.reasoningEffort,
    });
    if (!expertChatPanes.includes(pane)) return;
    pane.turn = snapshot;
    startExpertChatTurnPoll(pane);
    await applyExpertChatTurnSnapshot(pane, snapshot);
  } catch (error) {
    if (!expertChatPanes.includes(pane)) return;
    pane.turn = {
      ...pane.turn,
      id: 0,
      status: "failed",
      finishedAt: Math.floor(Date.now() / 1000),
      error: String(error),
    } as ChatTurnSnapshot;
    statusText = String(error);
    if (isQuotaExhaustionError(String(error))) refreshQuotaAlternatives();
    refreshExpertChatPane(pane);
  }
};

const stopExpertChatTurn = async (pane: ExpertChatPane) => {
  if (!pane.turn || pane.turn.status !== "running") return;
  if (pane.turn.id === 0) {
    pane.turn = { ...pane.turn, status: "cancelled" };
    stopExpertChatTurnPoll(pane);
    refreshExpertChatPane(pane);
    return;
  }
  try {
    await applyExpertChatTurnSnapshot(
      pane,
      await invoke<ChatTurnSnapshot>("stop_chat_turn", { id: pane.turn.id }),
    );
  } catch (error) {
    statusText = String(error);
  }
};

const startAllExpertChatWork = () => {
  expertChatPanes.forEach((pane) => {
    if (pane.discussion) {
      startExpertChatSync(pane);
      void loadExpertChatTranscript(pane);
    }
    if (pane.turn?.status === "running" && pane.turn.id !== 0) startExpertChatTurnPoll(pane);
  });
};

const activateExpertChatPane = (pane: ExpertChatPane, focusPrompt = false) => {
  if (!expertChatPanes.includes(pane)) return;
  activeExpertChatKey = pane.key;
  moveExpertChatPageToPane(pane);
  document.querySelectorAll<HTMLElement>("[data-chat-panel]").forEach((panel) => {
    panel.classList.toggle("active", panel.dataset.chatPanel === pane.key);
  });
  persistExpertChats();
  if (focusPrompt) {
    expertChatPaneRoot(pane)
      ?.querySelector<HTMLTextAreaElement>("[data-chat-control='prompt']")
      ?.focus();
  }
};

const setExpertChatPage = (requestedPage: number) => {
  captureAllExpertChatScroll();
  const environmentPanes = expertChatPanesForCurrentEnvironment();
  expertChatPage = clampExpertChatPage(
    requestedPage,
    environmentPanes.length,
    expertChatsPerPage,
  );
  const panes = visibleExpertChatPanes();
  if (!panes.some((pane) => pane.key === activeExpertChatKey)) {
    activeExpertChatKey = panes[0]?.key ?? null;
  }
  statusText = expertChatStatusText();
  persistExpertChats();
  render();
};

const addExpertChatPane = (
  accountId: string | null = null,
  options: { mode?: ChatMode; pendingWorkspace?: string | null } = {},
) => {
  const environmentPath = userEnvironmentPath(options.pendingWorkspace ?? currentWorkspace());
  if (!environmentPath) {
    openTerminalEnvironmentMenu();
    return null;
  }
  const pane = createExpertChatPane(null, {
    accountId: accountId ?? selectedAccountId ?? settings?.defaultAccountId ?? null,
    pendingWorkspace: environmentPath,
    mode: options.mode,
  });
  expertChatPanes.push(pane);
  activeExpertChatKey = pane.key;
  moveExpertChatPageToPane(pane);
  activeView = "chat";
  statusText = expertChatStatusText();
  persistExpertChats();
  render();
  window.setTimeout(() => activateExpertChatPane(pane, true), 0);
  return pane;
};

const openDiscussionInExpert = (discussion: DiscussionSummary) => {
  const existing = expertChatPanes.find(
    (pane) => pane.discussion?.sessionId === discussion.sessionId,
  );
  if (existing) {
    activeView = "chat";
    activateExpertChatPane(existing);
    statusText = expertChatStatusText();
    render();
    return;
  }
  const pane = createExpertChatPane(discussion);
  expertChatPanes.push(pane);
  activeExpertChatKey = pane.key;
  moveExpertChatPageToPane(pane);
  activeView = "chat";
  statusText = expertChatStatusText();
  void loadChatModelCatalog(pane.accountId);
  persistExpertChats();
  render();
  startExpertChatSync(pane);
  void loadExpertChatTranscript(pane);
};

const toggleExpertChatFullscreen = (pane: ExpertChatPane) => {
  if (!expertChatPanes.includes(pane)) return;
  expertChatFullscreenKey = expertChatFullscreenKey === pane.key ? null : pane.key;
  if (expertChatFullscreenKey) activeExpertChatKey = pane.key;
  render();
  if (expertChatFullscreenKey) {
    window.requestAnimationFrame(() => {
      expertChatPaneRoot(pane)
        ?.querySelector<HTMLTextAreaElement>("[data-chat-control='prompt']")
        ?.focus();
    });
  }
};

const closeExpertChatPane = (pane: ExpertChatPane) => {
  if (pane.turn?.status === "running") {
    statusText = "Arretez la reponse avant de fermer ce chat";
    return;
  }
  const index = expertChatPanes.indexOf(pane);
  if (index < 0) return;
  stopExpertChatSync(pane);
  stopExpertChatTurnPoll(pane);
  expertChatPanes.splice(index, 1);
  const environmentPanes = expertChatPanesForCurrentEnvironment();
  if (activeExpertChatKey === pane.key) {
    activeExpertChatKey = environmentPanes[0]?.key ?? null;
  }
  if (expertChatFullscreenKey === pane.key) expertChatFullscreenKey = null;
  reconcileExpertChatPage();
  statusText = expertChatStatusText();
  persistExpertChats();
  render();
};

const bindExpertChatPaneUi = (pane: ExpertChatPane, root: HTMLElement) => {
  root.addEventListener("pointerdown", () => {
    if (pane.key !== activeExpertChatKey) activateExpertChatPane(pane);
  });

  root.querySelector<HTMLButtonElement>("[data-chat-action='back']")?.addEventListener("click", () => {
    if (window.matchMedia("(max-width: 760px)").matches) {
      document.body.classList.add("chat-sidebar-open");
    } else {
      setActiveView("discussions");
    }
  });
  root.querySelector<HTMLButtonElement>("[data-chat-action='new']")?.addEventListener("click", () => openNewChatModal());
  root.querySelector<HTMLButtonElement>("[data-chat-action='close']")?.addEventListener("click", () => closeExpertChatPane(pane));
  root.querySelector<HTMLButtonElement>("[data-chat-action='fullscreen']")?.addEventListener("click", () => toggleExpertChatFullscreen(pane));
  root.querySelector<HTMLButtonElement>("[data-chat-action='refresh']")?.addEventListener("click", () => {
    if (pane.discussion) void loadExpertChatTranscript(pane);
    else void refreshDiscussions();
  });
  root.querySelector<HTMLButtonElement>("[data-chat-action='history-toggle']")?.addEventListener("click", () => {
    pane.historyOpen = !pane.historyOpen;
    refreshExpertChatPane(pane);
  });
  root.querySelector<HTMLButtonElement>("[data-chat-action='history-close']")?.addEventListener("click", () => {
    pane.historyOpen = false;
    refreshExpertChatPane(pane);
  });
  root.querySelectorAll<HTMLButtonElement>("[data-chat-history-message]").forEach((button) => {
    button.addEventListener("click", () => {
      const index = Number(button.dataset.chatHistoryMessage);
      if (!Number.isInteger(index)) return;
      const reveal = () => {
        const message = root.querySelector<HTMLElement>(`[data-chat-message-index='${index}']`);
        message?.scrollIntoView({ behavior: "smooth", block: "center" });
        message?.classList.add("chat-msg--located");
        window.setTimeout(() => message?.classList.remove("chat-msg--located"), 1400);
      };
      if (window.matchMedia("(max-width: 760px)").matches) {
        pane.historyOpen = false;
        refreshExpertChatPane(pane);
        window.requestAnimationFrame(() => {
          const nextRoot = expertChatPaneRoot(pane);
          const message = nextRoot?.querySelector<HTMLElement>(`[data-chat-message-index='${index}']`);
          message?.scrollIntoView({ behavior: "smooth", block: "center" });
        });
      } else {
        reveal();
      }
    });
  });
  root.querySelector<HTMLButtonElement>("[data-chat-action='stop']")?.addEventListener("click", () => {
    void stopExpertChatTurn(pane);
  });
  root
    .querySelector<HTMLButtonElement>("[data-chat-action='quota-switch'][data-quota-account]")
    ?.addEventListener("click", (event) => {
      const targetAccountId = (event.currentTarget as HTMLButtonElement).dataset.quotaAccount;
      if (pane.discussion && targetAccountId) {
        activeExpertChatKey = pane.key;
        void continueDiscussionWith(pane.discussion, targetAccountId);
      }
    });

  const prompt = root.querySelector<HTMLTextAreaElement>("[data-chat-control='prompt']");
  const resizePrompt = () => {
    if (!prompt) return;
    prompt.style.height = "0px";
    prompt.style.height = `${Math.min(prompt.scrollHeight, 190)}px`;
  };
  prompt?.addEventListener("input", () => {
    pane.draft = prompt.value;
    resizePrompt();
  });
  prompt?.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
      event.preventDefault();
      void sendExpertChatMessage(pane, root);
    }
  });
  resizePrompt();
  root.querySelector<HTMLFormElement>("[data-chat-control='composer']")?.addEventListener("submit", (event) => {
    event.preventDefault();
    void sendExpertChatMessage(pane, root);
  });
  root.querySelector<HTMLSelectElement>("[data-chat-control='mode']")?.addEventListener("change", (event) => {
    pane.mode = (event.currentTarget as HTMLSelectElement).value as ChatMode;
    persistExpertChats();
  });

  const modelInput = root.querySelector<HTMLInputElement>("[data-chat-control='model']");
  const commitPreferences = () => {
    const account = expertChatSelectedAccount(pane);
    if (!account) return false;
    const preferences = readChatPreferences(account, root);
    modelInput?.setCustomValidity(preferences.error ?? "");
    if (preferences.error) {
      modelInput?.reportValidity();
      statusText = preferences.error;
      return false;
    }
    if (preferences.changed) persistChatPreferences(account.id);
    return true;
  };
  modelInput?.addEventListener("input", () => modelInput.setCustomValidity(""));
  modelInput?.addEventListener("change", () => {
    if (commitPreferences()) refreshExpertChatPane(pane);
  });
  modelInput?.addEventListener("keydown", (event) => {
    if (event.key !== "Enter") return;
    event.preventDefault();
    modelInput.blur();
  });
  root.querySelector<HTMLSelectElement>("[data-chat-control='reasoning-effort']")?.addEventListener("change", commitPreferences);
  root.querySelectorAll<HTMLButtonElement>("[data-chat-starter]").forEach((button) => {
    button.addEventListener("click", () => {
      pane.draft = button.dataset.chatStarter ?? "";
      if (prompt) {
        prompt.value = pane.draft;
        prompt.dispatchEvent(new Event("input"));
        prompt.focus();
        prompt.setSelectionRange(prompt.value.length, prompt.value.length);
      }
    });
  });

  const feed = root.querySelector<HTMLDivElement>("[data-chat-control='feed']");
  feed?.addEventListener("scroll", () => captureExpertChatScroll(pane, root), { passive: true });
  feed?.addEventListener("wheel", (event) => {
    if (event.deltaY < 0 && feed.scrollTop > 0) {
      pane.followLatest = false;
      pane.scrollTop = feed.scrollTop;
    }
  }, { passive: true });
  feed?.addEventListener("click", (event) => {
    const button = (event.target as HTMLElement | null)?.closest<HTMLButtonElement>(".chat-code-copy");
    if (!button) return;
    const code = button.closest(".chat-code")?.querySelector("code")?.textContent ?? "";
    if (!code) return;
    void navigator.clipboard.writeText(code).then(() => {
      button.classList.add("copied");
      window.setTimeout(() => button.classList.remove("copied"), 1200);
    });
  });
};

const bindExpertChatGridUi = () => {
  expertChatPanes.forEach((pane) => {
    const root = expertChatPaneRoot(pane);
    if (root) {
      bindExpertChatPaneUi(pane, root);
      restoreExpertChatScroll(pane, root);
    }
  });
};

const renderDiscussionRow = (discussion: DiscussionSummary, accountLabel: string) => {
  const busy = discussionBusyId === discussion.sessionId;
  const title = discussion.title?.trim() || "(sans titre)";
  const subtitle = discussionSubtitle(discussion);
  const provider = discussion.provider ?? "codex";
  const folderPath = discussionFolderPath(discussion);
  const meta = [
    `<span class="discussion-badge prov-${provider}" title="Fournisseur d'origine"><i data-lucide="cpu"></i>${escapeHtml(providerLabel(provider))}</span>`,
    folderPath
      ? `<span title="${escapeAttr(folderPath)}"><i data-lucide="folder-open"></i>${escapeHtml(displayProjectDir(folderPath))}</span>`
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

  // Compte cible : origine EN PREMIER (marquee), puis les autres. Choisir un
  // autre compte transforme la reprise en deplacement (copie fidele puis
  // archivage de la source) — logique portee par continueDiscussionWith.
  const accounts = settings?.accounts ?? [];
  const target = discussionTargetFor(discussion);
  const willCopy = target !== discussion.accountId;
  const options =
    accounts
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
        <button class="tool-button" data-resume-session="${escapeAttr(discussion.sessionId)}" title="${willCopy ? "Déplacer la discussion dans le compte choisi puis la reprendre automatiquement" : "Reprendre dans un terminal"}">
          <i data-lucide="${willCopy ? "copy" : "play"}"></i><span data-resume-label>${willCopy ? "Déplacer + reprendre" : "Reprendre"}</span>
        </button>
        <button class="tool-button primary" data-open-chat="${escapeAttr(discussion.sessionId)}" title="Ouvrir cette conversation dans le chat">
          <i data-lucide="messages-square"></i><span>Ouvrir le chat</span>
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
            <input id="discussionSearch" type="search" placeholder="Rechercher (titre, environnement, id)" value="${escapeAttr(discussionSearch)}" />
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

const clearChatDragUi = () => {
  draggedChatSessionId = null;
  document
    .querySelectorAll<HTMLElement>(".chat-side-item.dragging, .chat-workspace-group.drag-over")
    .forEach((element) => element.classList.remove("dragging", "drag-over"));
  document.body.classList.remove("chat-dragging");
};

// Attache les gestionnaires de la liste de workspaces. Le root optionnel permet
// de rebinder seulement les groupes remplaces par un rafraichissement cible.
const bindWorkspaceSwitcherUi = (root: ParentNode = document) => {
  root.querySelector<HTMLButtonElement>("#chooseEnvironmentFromSidebar")?.addEventListener(
    "click",
    openTerminalEnvironmentMenu,
  );
  root.querySelectorAll<HTMLButtonElement>("[data-ws-select]").forEach((button) => {
    button.addEventListener("click", () => {
      const value = button.dataset.wsSelect;
      if (value) void openFolderTerminals(value);
    });
  });
  root.querySelectorAll<HTMLButtonElement>("[data-open-folder-terminal]").forEach((button) => {
    button.addEventListener("click", () => {
      const session = terminalSessions.find(
        (candidate) => candidate.key === button.dataset.openFolderTerminal,
      );
      if (!session) return;
      activateTerminalSession(session);
      requestTerminalFocusKey = session.key;
      activeView = "terminal";
      stopLimitPoll();
      stopUsagePoll();
      stopKombaiPoll();
      stopDiscussionsPoll();
      stopRoomPoll();
      stopChatSync();
      statusText = `Terminal actif: ${terminalTitle(session)}`;
      render();
      persistTerminalSessions();
    });
  });
  root.querySelectorAll<HTMLButtonElement>("[data-new-chat-workspace]").forEach((button) => {
    button.addEventListener("click", () => {
      const workspace = knownWorkspaces().find(
        (candidate) => candidate.id === button.dataset.newChatWorkspace,
      );
      if (!workspace) return;
      setCurrentWorkspace(workspace.path);
      setChatWorkspaceFilter(workspace.id);
      pendingChatWorkspace = workspace.path;
      void upsertWorkspaceRegistry(workspace.path);
      openNewChat();
    });
  });
  root.querySelectorAll<HTMLButtonElement>("[data-close-workspace]").forEach((button) => {
    button.addEventListener("click", (event) => {
      event.stopPropagation();
      const id = button.dataset.closeWorkspace;
      const workspace = knownWorkspaces().find((candidate) => candidate.id === id);
      if (workspace) void closeWorkspace(workspace);
    });
  });
  root.querySelector<HTMLButtonElement>("#wsOpenFolder")?.addEventListener("click", () => {
    openTerminalEnvironmentMenu();
  });
  root.querySelector<HTMLButtonElement>("#workspaceLiveGraph")?.addEventListener("click", () => {
    openWorkspaceLiveGraph();
  });

  root
    .querySelectorAll<HTMLElement>("[data-drag-chat][draggable=\"true\"]")
    .forEach((row) => {
      row.addEventListener("dragstart", (event) => {
        const dragEvent = event as DragEvent;
        const sessionId = row.dataset.dragChat;
        const discussion = findDiscussion(sessionId);
        if (!sessionId || !discussion || discussionBusyId || discussionHasRunningTurn(discussion)) {
          dragEvent.preventDefault();
          return;
        }
        draggedChatSessionId = sessionId;
        dragEvent.dataTransfer?.setData(CHAT_DRAG_MIME, sessionId);
        dragEvent.dataTransfer?.setData("text/plain", sessionId);
        if (dragEvent.dataTransfer) dragEvent.dataTransfer.effectAllowed = "move";
        document.body.classList.add("chat-dragging");
        window.requestAnimationFrame(() => row.classList.add("dragging"));
      });
      row.addEventListener("dragend", clearChatDragUi);
    });

  root.querySelectorAll<HTMLElement>("[data-chat-drop-workspace]").forEach((target) => {
    const dropContext = (event: DragEvent) => {
      const sessionId =
        draggedChatSessionId || event.dataTransfer?.getData(CHAT_DRAG_MIME) || null;
      const discussion = findDiscussion(sessionId);
      const workspace = knownWorkspaces().find(
        (candidate) => candidate.id === target.dataset.chatDropWorkspace,
      );
      if (!discussion || !workspace || discussionBusyId || discussionHasRunningTurn(discussion)) {
        return null;
      }
      const folderPath = discussionFolderPath(discussion);
      if (folderPath && normalizeWorkspacePath(folderPath) === normalizeWorkspacePath(workspace.path)) {
        return null;
      }
      return { discussion, workspace };
    };

    target.addEventListener("dragover", (event) => {
      const dragEvent = event as DragEvent;
      if (!dropContext(dragEvent)) return;
      dragEvent.preventDefault();
      if (dragEvent.dataTransfer) dragEvent.dataTransfer.dropEffect = "move";
      document
        .querySelectorAll<HTMLElement>(".chat-workspace-group.drag-over")
        .forEach((group) => group.classList.toggle("drag-over", group === target));
    });
    target.addEventListener("dragleave", (event) => {
      const related = (event as DragEvent).relatedTarget;
      if (related instanceof Node && target.contains(related)) return;
      target.classList.remove("drag-over");
    });
    target.addEventListener("drop", (event) => {
      const dragEvent = event as DragEvent;
      const context = dropContext(dragEvent);
      if (!context) return;
      dragEvent.preventDefault();
      clearChatDragUi();
      void moveDiscussionToWorkspace(context.discussion, context.workspace);
    });
  });
};

// Rafraichit uniquement l'en-tete des workspaces sans re-render global.
const refreshWorkspaceSwitcher = () => {
  const current = document.querySelector<HTMLElement>("#chatWsSwitcher");
  if (!current) return;
  // Rien n'a change depuis le dernier rendu : on ne touche pas au DOM (evite
  // repaint/perte de focus inutiles a chaque poll).
  if (current.dataset.wsSig === workspaceSwitcherSignature()) return;
  const wrapper = document.createElement("div");
  wrapper.innerHTML = renderWorkspaceSwitcher();
  const next = wrapper.firstElementChild;
  if (!next) return;
  current.replaceWith(next);
  createIcons({ icons: lucideIcons });
  bindWorkspaceSwitcherUi(next);
};

const bindDiscussionRowUi = () => {
  document.querySelectorAll<HTMLButtonElement>("[data-delete-session]").forEach((button) => {
    button.addEventListener("click", () => {
      const discussion = findDiscussion(button.dataset.deleteSession);
      if (discussion) void deleteDiscussion(discussion);
    });
  });
  document.querySelectorAll<HTMLButtonElement>("[data-open-chat]").forEach((button) => {
    button.addEventListener("click", () => {
      const discussion = findDiscussion(button.dataset.openChat);
      if (discussion) openDiscussionChat(discussion);
    });
  });
  // Rangees de brouillons (chats ouverts sans discussion listee) : activees et
  // fermees par cle de pane, faute de sessionId a resoudre.
  document.querySelectorAll<HTMLButtonElement>("[data-open-pane]").forEach((button) => {
    button.addEventListener("click", () => {
      const pane = expertChatPanes.find((item) => item.key === button.dataset.openPane);
      if (!pane) return;
      activeView = "chat";
      activateExpertChatPane(pane, true);
      statusText = expertChatStatusText();
      render();
    });
  });
  document.querySelectorAll<HTMLButtonElement>("[data-close-pane]").forEach((button) => {
    button.addEventListener("click", () => {
      const pane = expertChatPanes.find((item) => item.key === button.dataset.closePane);
      if (pane) closeExpertChatPane(pane);
    });
  });
  // Changement de compte cible : on memorise le choix et on met a jour, sans
  // re-render complet, le libelle/icone du bouton (Reprendre <-> Deplacer +
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
      if (label) label.textContent = willCopy ? "Déplacer + reprendre" : "Reprendre";
      if (button) {
        button.title = willCopy
          ? "Déplacer la discussion dans le compte choisi puis la reprendre automatiquement"
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
};

// --- Historique des demandes, regroupe par chat / terminal ----------------
// Le backend renvoie les messages utilisateur individuellement. La vue les
// regroupe par session ET par compte afin qu'une carte resume exclusivement les
// messages envoyes dans le chat ou le terminal correspondant.
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

const promptSessions = (): PromptSessionHistory[] => {
  const groups = new Map<string, PromptSessionHistory>();
  for (const entry of allPrompts()) {
    const key = `${entry.accountId}\u0000${entry.sessionId}`;
    const existing = groups.get(key);
    if (existing) {
      const duplicate = existing.prompts.some(
        (candidate) => candidate.timestamp === entry.timestamp && candidate.text === entry.text,
      );
      if (!duplicate) existing.prompts.push(entry);
      existing.firstTimestamp = Math.min(existing.firstTimestamp, entry.timestamp);
      existing.lastTimestamp = Math.max(existing.lastTimestamp, entry.timestamp);
      existing.cwd ||= entry.cwd;
      existing.sessionTitle ||= entry.sessionTitle;
      continue;
    }
    groups.set(key, {
      key,
      sessionId: entry.sessionId,
      accountId: entry.accountId,
      accountLabel: entry.accountLabel,
      cwd: entry.cwd,
      sessionTitle: entry.sessionTitle,
      firstTimestamp: entry.timestamp,
      lastTimestamp: entry.timestamp,
      prompts: [entry],
    });
  }
  return [...groups.values()]
    .map((session) => ({
      ...session,
      prompts: session.prompts.sort((left, right) => left.timestamp - right.timestamp),
    }))
    .sort((left, right) => right.lastTimestamp - left.lastTimestamp);
};

const promptSessionMatches = (session: PromptSessionHistory) => {
  const query = promptSearch.trim().toLowerCase();
  if (!query) return true;
  return [
    ...session.prompts.map((entry) => entry.text),
    session.cwd ?? "",
    session.accountLabel,
    session.sessionTitle ?? "",
    session.sessionId,
  ].some((field) => field.toLowerCase().includes(query));
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

const renderPromptSession = (session: PromptSessionHistory) => {
  const meta = [
    `<span><i data-lucide="clock-3"></i>${escapeHtml(formatTimestamp(session.lastTimestamp))}</span>`,
    `<span><i data-lucide="users"></i>${escapeHtml(session.accountLabel)}</span>`,
    session.cwd
      ? `<span title="${escapeAttr(session.cwd)}"><i data-lucide="folder-open"></i>${escapeHtml(displayProjectDir(session.cwd))}</span>`
      : "",
    `<span><i data-lucide="message-square-text"></i>${session.prompts.length} message(s) envoye(s)</span>`,
  ]
    .filter(Boolean)
    .join("");
  const title = session.sessionTitle?.trim() || session.prompts[0]?.text.trim() || "Session sans titre";
  const messages = session.prompts
    .map(
      (entry, index) => `
        <li>
          <span class="prompt-message-index">${index + 1}</span>
          <span>${highlightMatch(entry.text, promptSearch)}</span>
          <time>${escapeHtml(formatTimestamp(entry.timestamp))}</time>
        </li>`,
    )
    .join("");
  return `
    <div class="prompt-row prompt-session-row">
      <div class="prompt-main">
        <strong class="prompt-session-title">${highlightMatch(title, promptSearch)}</strong>
        <span class="prompt-meta">${meta}</span>
        <ol class="prompt-session-messages">${messages}</ol>
      </div>
      <div class="prompt-actions">
        <button class="tool-button" data-prompt-discussion="${escapeAttr(session.sessionId)}" data-prompt-account="${escapeAttr(session.accountId)}" title="Voir la conversation">
          <i data-lucide="messages-square"></i><span>Conversation</span>
        </button>
      </div>
    </div>
  `;
};

const renderPromptRows = () => {
  if (!promptHistoryLoaded) {
    return `<div class="pool-empty">Lecture des demandes Codex…</div>`;
  }
  const all = promptSessions();
  if (all.length === 0) {
    return `<div class="pool-empty">Aucune demande trouvee</div>`;
  }
  const matches = all.filter(promptSessionMatches);
  if (matches.length === 0) {
    return `<div class="pool-empty">Aucune demande ne correspond a « ${escapeHtml(promptSearch)} »</div>`;
  }
  const shown = matches.slice(0, PROMPT_RENDER_LIMIT);
  const capped =
    matches.length > shown.length
      ? `<div class="prompt-more">Affichage limite a ${PROMPT_RENDER_LIMIT} sur ${matches.length} resultats — affine la recherche.</div>`
      : "";
  return `${shown.map(renderPromptSession).join("")}${capped}`;
};

const renderPromptHistoryPanel = () => {
  const returned = promptHistory?.returned ?? 0;
  const truncatedNote = promptHistory?.truncated ? ` · ${returned} plus recentes indexees` : "";
  const sessions = promptSessions();
  const sessionCount = sessions.length;
  const messageCount = sessions.reduce((sum, session) => sum + session.prompts.length, 0);
  const countLabel = promptHistoryLoaded
    ? `${sessionCount} chat(s) / terminal(aux) · ${messageCount} message(s)${truncatedNote}`
    : "Lecture…";
  return `
    <section class="discussions-panel">
      <div class="discussions-head">
        <div>
          <strong>Historique par chat ou terminal</strong>
          <span>${escapeHtml(countLabel)}</span>
        </div>
        <div class="discussions-tools">
          <label class="discussion-search">
            <i data-lucide="search"></i>
            <input id="promptSearch" type="search" placeholder="Rechercher dans les chats, terminaux et messages" value="${escapeAttr(promptSearch)}" />
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

const openDiscussionForSession = (accountId: string, sessionId: string) => {
  const discussion = allDiscussions().find(
    (candidate) => candidate.accountId === accountId && candidate.sessionId === sessionId,
  );
  if (discussion) {
    openDiscussionChat(discussion);
    return;
  }
  discussionSearch = sessionId;
  if (activeView === "discussions") {
    refreshDiscussionList();
  } else {
    setActiveView("discussions");
  }
};

const bindPromptRowUi = () => {
  document.querySelectorAll<HTMLButtonElement>("[data-prompt-discussion]").forEach((button) => {
    button.addEventListener("click", () => {
      const sessionId = button.dataset.promptDiscussion;
      const accountId = button.dataset.promptAccount;
      if (accountId && sessionId) openDiscussionForSession(accountId, sessionId);
    });
  });
};

const restoreTerminals = async () => {
  if (!settings) return;
  const state = loadOpenTerminalRecords();
  const eligibleRecords = state.terminals.filter(
    (record) =>
      settings!.accounts.some((account) => account.id === record.accountId) &&
      !!userEnvironmentPath(record.folderPath),
  );
  const records = eligibleRecords.slice(0, EXPERT_MAX_TERMINALS);
  if (records.length === 0) {
    if (state.terminals.length > 0) persistTerminalSessions();
    return;
  }

  const restored: TerminalSession[] = [];
  for (const record of records) {
    const account = settings.accounts.find((candidate) => candidate.id === record.accountId);
    if (!account) continue;
    const agentId =
      record.agentId && settings.agents.some((agent) => agent.id === record.agentId)
        ? record.agentId
        : codexAgentId();
    const restoredFolder = userEnvironmentPath(record.folderPath);
    if (!restoredFolder) continue;
    const session = createTerminalSession(
      account,
      proxyForAccount(account),
      agentId,
      restoredFolder,
    );
    session.key = record.key;
    session.codexSessionId = record.codexSessionId ?? null;
    session.resumeSessionId = record.codexSessionId ?? null;
    session.workspaceId = record.workspaceId?.trim() || null;
    session.workspacePath = record.workspacePath?.trim() || null;
    session.projectDir = record.projectDir?.trim() || account.projectDir?.trim() || null;
    if (session.codexSessionId) claimedSessionIds.add(session.codexSessionId);
    terminalSessions.push(session);
    restored.push(session);
  }

  if (restored.length === 0) return;

  activeTerminalKey =
    (state.activeKey && restored.some((session) => session.key === state.activeKey) && state.activeKey) ||
    restored[0].key;
  const restoredActive = activeTerminal();
  if (restoredActive && activeView === "terminal") activateTerminalSession(restoredActive);
  if (activeView === "terminal") render();

  for (const session of restored) {
    const command = isPlausibleSessionId(session.codexSessionId)
      ? buildResumeCommand(session.codexSessionId, accountById(session.accountId))
      : null;
    await startTerminalSession(session, command);
  }

  if (eligibleRecords.length > EXPERT_MAX_TERMINALS) {
    statusText = `${EXPERT_MAX_TERMINALS} terminaux restaures; la limite de la fenetre est atteinte`;
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

    selectedAccountId = accountId;
    openNewTerminalModal(null);
    statusText = "Choisis l'environnement du terminal de test, puis relance le test";
    render();
    return;
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
    statusText = "Environnement projet associe";
  } catch (error) {
    statusText = String(error);
  }

  render();
};

// --- Selecteur de workspace ----------------------------------------------
// Ouvre le choix de l'environnement actif ou celui du terminal en cours de
// creation. Desktop : dialogue natif. Web : navigateur de dossiers du serveur.
const workspacePickerPath = () =>
  userEnvironmentPath(
    workspacePickerTarget === "new-terminal" ? newTerminalWorkspacePath : currentWorkspace(),
  );

const chooseWorkspace = (
  path: string | null,
  target: WorkspacePickerTarget = workspacePickerTarget,
) => {
  const requested = path?.trim() || null;
  const trimmed = userEnvironmentPath(requested);
  if (requested && !trimmed) {
    statusText = "Ce dossier est un workspace technique temporaire et ne peut pas etre ajoute";
    render();
    return;
  }
  if (target === "new-terminal") {
    newTerminalWorkspacePath = trimmed;
    if (trimmed) rememberWorkspace(trimmed);
    statusText = trimmed
      ? `Environnement du nouveau terminal: ${trimmed}`
      : "Choisis un environnement: aucun terminal ne peut utiliser un contexte implicite";
  } else {
    if (trimmed) {
      workspaceModalOpen = false;
      void selectEnvironment(trimmed);
      return;
    }
    setCurrentWorkspace(null);
    setChatWorkspaceFilter(WORKSPACE_ALL);
    pendingChatWorkspace = null;
    terminalFolderFilter = null;
    activeView = "chat";
    startDiscussionsPoll();
    statusText = "Choisis un environnement pour commencer";
  }
  workspaceModalOpen = false;
  render();
};

// Selectionne le workspace cible depuis son groupe lateral. Tous les groupes
// restent affiches ; un workspace reel devient le cwd des prochains chats.
const openFolderTerminals = async (value: string): Promise<void> => {
  const workspace = knownWorkspaces().find((candidate) => candidate.id === value);
  if (!workspace) return;

  setChatWorkspaceFilter(workspace.id);
  setCurrentWorkspace(workspace.path);
  pendingChatWorkspace = null;
  terminalFolderFilter = workspace.path;
  void upsertWorkspaceRegistry(workspace.path);
  activeView = "terminal";
  stopLimitPoll();
  stopUsagePoll();
  stopKombaiPoll();
  stopDiscussionsPoll();
  stopRoomPoll();
  stopChatSync();
  statusText = `Ouverture de l'environnement ${workspace.label}`;
  render();

  await ensureTerminalsRestored();
  const sessions = terminalSessionsForFolder(workspace.path);
  const current = sessions.find((session) => session.key === activeTerminalKey) ?? sessions[0];
  if (current) activateTerminalSession(current);
  else activeTerminalKey = null;
  terminalFolderFilter = workspace.path;
  const terminalLabel = sessions.length === 1 ? "1 terminal associe" : `${sessions.length} terminaux associes`;
  statusText = `${workspace.label} · ${terminalLabel}`;
  render();
};

const closeExpertChatAndDiscussion = async (pane: ExpertChatPane) => {
  if (!expertChatPanes.includes(pane)) return;
  if (pane.turn?.status === "running") {
    statusText = "Arretez la reponse avant de fermer ce chat";
    render();
    return;
  }
  const discussion = pane.discussion;
  if (!discussion) {
    closeExpertChatPane(pane);
    return;
  }
  if (discussionHasRunningTurn(discussion)) {
    statusText = "Arretez la reponse avant de supprimer cette discussion";
    render();
    return;
  }

  discussionBusyId = discussion.sessionId;
  let finalStatus: string;
  try {
    const count = await archiveDiscussionById(
      discussion.accountId,
      discussion.sessionId,
      [discussion.rolloutId],
    );
    finalStatus = count > 1
      ? `Chat ferme et discussion archivee (${count} fichiers)`
      : "Chat ferme et discussion archivee";
  } catch (error) {
    finalStatus = `Suppression du chat impossible : ${String(error)}`;
  }
  discussionBusyId = null;
  await refreshDiscussions();
  statusText = finalStatus;
  render();
};

const selectWorkspaceFilter = (value: string) => {
  setChatWorkspaceFilter(value);
  pendingChatWorkspace = null;
  if (value !== WORKSPACE_ALL && value !== WORKSPACE_UNKNOWN) {
    const workspace = knownWorkspaces().find((ws) => ws.id === value);
    if (workspace) {
      setCurrentWorkspace(workspace.path);
      void upsertWorkspaceRegistry(workspace.path);
      statusText = `Environnement actif: ${workspace.label}`;
    }
  } else {
    statusText =
      value === WORKSPACE_UNKNOWN ? "Chats sans environnement" : "Toutes les conversations";
  }
  if (activeView !== "chat") {
    setActiveView("chat");
  } else {
    render();
  }
};

const openWorkspacePicker = async (target: WorkspacePickerTarget = "active") => {
  workspacePickerTarget = target;
  if (isRemoteMode()) {
    workspaceModalOpen = true;
    workspaceBrowse = null;
    workspaceBrowseError = "";
    render();
    await loadWorkspaceDir(workspacePickerPath());
    return;
  }

  try {
    const picked = await invoke<string | null>("pick_project_dir", {
      currentDir: workspacePickerPath() ?? "",
    });
    if (picked) {
      chooseWorkspace(picked, target);
      return;
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

const createPoolTerminal = async () => {
  await ensureTerminalsRestored();
  if (terminalSessions.length >= EXPERT_MAX_TERMINALS) {
    statusText = `Limite atteinte: ${EXPERT_MAX_TERMINALS} terminaux maximum dans une fenetre`;
    render();
    return;
  }
  try {
    const picked = await invoke<AccountProfile>("pool_pick_terminal_account");
    settings = await invoke<AppSettings>("load_settings");
    selectedAccountId = picked.id;
    openNewTerminalModal(null);
    statusText = `Pool -> ${picked.label} · choisis l'environnement avant de demarrer`;
    render();
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
        <button class="icon-button danger" data-remove-account-confirm="${escapeAttr(account.id)}" title="Retirer du pool (garder les fichiers sur le disque)">
          <i data-lucide="check"></i>
        </button>
        <button class="icon-button danger" data-remove-account-purge="${escapeAttr(account.id)}" title="Retirer ET supprimer l'environnement du disque (irréversible)">
          <i data-lucide="folder-x"></i>
        </button>
        <button class="icon-button" data-remove-account-cancel="${escapeAttr(account.id)}" title="Annuler">
          <i data-lucide="x"></i>
        </button>
      </div>`
    : `<button class="icon-button danger" data-remove-account="${escapeAttr(account.id)}" title="Retirer ce compte du pool">
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
      // Le dossier/repo est un instantane du lancement. Modifier le compte ne
      // doit pas reclasser un terminal deja ouvert dans un autre workspace.
      session.proxySummary = proxySummary;
    }
  });
};

// --- Coque mobile : barre haute + navigation basse + tiroir lateral, injectes
// une seule fois hors de #app (comme .eh-bg) pour survivre aux re-render. Les
// controles pilotent directement les fonctions internes (setActiveView,
// modales...) plutot que de simuler des clics : rien a re-binder a chaque rendu.
function closeMobileOverlays(): void {
  document.body.classList.remove("m-drawer-open", "m-sheet-open");
}

function mobileViewLabel(view: AppView): string {
  switch (view) {
    case "pool":
      return "Pool";
    case "limits":
      return "Limites";
    case "dashboard":
      return "Stats";
    case "kombai":
      return "Kombai";
    case "discussions":
      return "Discussions";
    case "chat":
      return "Conversation";
    case "history":
      return "Historique";
    case "room":
      return "Salon";
    case "audit":
      return "Audit";
    case "skills":
      return "Skills";
    default:
      return "Terminal";
  }
}

function syncMobileChrome(): void {
  const chrome = document.querySelector(".m-chrome");
  if (!chrome) return;
  chrome.querySelectorAll<HTMLElement>(".m-tab[data-view]").forEach((tab) => {
    const view = tab.getAttribute("data-view");
    const active =
      view === "discussions"
        ? activeView === "discussions" || activeView === "chat"
        : view === "terminal"
          ? activeView === "terminal"
          : activeView === view;
    tab.classList.toggle("active", active);
  });
  const title = document.getElementById("mTitle");
  if (title) {
    const session = activeTerminal();
    title.textContent =
      activeView !== "terminal"
        ? mobileViewLabel(activeView)
        : session
          ? terminalTitle(session)
          : "Codex Terminal";
  }
}

const bindGlobalMobileListeners = () => {
  if (globalMobileListenersBound) return;
  globalMobileListenersBound = true;
  document.addEventListener("click", (event) => {
    if (
      (event.target as HTMLElement).closest(
        "[data-terminal-key],[data-close-terminal],[data-workspace-key],[data-new-terminal-workspace],[data-close-workspace],#newTerminalSide,#workspaceAddSide",
      )
    ) {
      document.body.classList.remove("m-drawer-open");
    }
  });
  const refit = () => {
    window.clearTimeout(mobileRefitTimer);
    mobileRefitTimer = window.setTimeout(() => fitAndResizeVisibleTerminals(), 120);
  };
  window.visualViewport?.addEventListener("resize", refit);
  window.addEventListener("orientationchange", () =>
    window.setTimeout(() => fitAndResizeVisibleTerminals(), 280),
  );
};

function ensureMobileChrome(): void {
  if (typeof document === "undefined" || !document.body) return;
  if (document.querySelector(".m-chrome")) {
    syncMobileChrome();
    return;
  }

  const chrome = document.createElement("div");
  chrome.className = "m-chrome";
  chrome.innerHTML = `
    <header class="m-topbar">
      <button class="m-icon" type="button" data-m="drawer" aria-label="Terminaux ouverts">
        <i data-lucide="menu"></i>
      </button>
      <div class="m-title"><strong id="mTitle">Codex Terminal</strong></div>
      <button class="m-icon" type="button" data-m="new" aria-label="Nouveau terminal">
        <i data-lucide="plus"></i>
      </button>
    </header>
    <nav class="m-bottomnav" aria-label="Navigation">
      <button class="m-tab" type="button" data-view="terminal"><i data-lucide="square-terminal"></i><span>Terminal</span></button>
      <button class="m-tab" type="button" data-view="pool"><i data-lucide="server"></i><span>Pool</span></button>
      <button class="m-tab" type="button" data-view="dashboard"><i data-lucide="bar-chart-3"></i><span>Stats</span></button>
      <button class="m-tab" type="button" data-view="room"><i data-lucide="users"></i><span>Salon</span></button>
      <button class="m-tab" type="button" data-m="menu"><i data-lucide="layout-grid"></i><span>Menu</span></button>
    </nav>
    <div class="m-scrim" data-m="scrim"></div>
    <div class="m-sheet">
      <div class="m-sheet-panel" role="menu" aria-label="Plus d'actions">
        <div class="m-sheet-handle"></div>
        <div class="m-sheet-grid">
          <button type="button" data-view="limits"><i data-lucide="calendar-clock"></i><span>Limites</span></button>
          <button type="button" data-view="kombai"><i data-lucide="bot"></i><span>Kombai</span></button>
          <button type="button" data-view="discussions"><i data-lucide="messages-square"></i><span>Discussions</span></button>
          <button type="button" data-view="history"><i data-lucide="history"></i><span>Historique</span></button>
          <button type="button" data-view="skills"><i data-lucide="library"></i><span>Skills</span></button>
          <button type="button" data-view="audit"><i data-lucide="scan-eye"></i><span>Audit</span></button>
          <button type="button" data-act="poolTerminal"><i data-lucide="shuffle"></i><span>Pool term</span></button>
          <button type="button" data-act="agents"><i data-lucide="bot"></i><span>Agents</span></button>
          <button type="button" data-act="fullscreen"><i data-lucide="maximize-2"></i><span>Plein ecran</span></button>
        </div>
      </div>
    </div>
  `;
  document.body.appendChild(chrome);

  const gotoView = (view: AppView) => {
    if (view === "terminal") {
      if (activeView !== "terminal") setActiveView("terminal");
    } else if (activeView !== view) {
      setActiveView(view);
    }
    closeMobileOverlays();
    syncMobileChrome();
  };

  chrome.addEventListener("click", (event) => {
    const el = (event.target as HTMLElement).closest<HTMLElement>(
      "[data-m],[data-view],[data-act]",
    );
    if (!el) return;

    const view = el.getAttribute("data-view");
    if (view) {
      gotoView(view as AppView);
      return;
    }

    const act = el.getAttribute("data-act");
    if (act) {
      closeMobileOverlays();
      if (act === "poolTerminal") void createPoolTerminal();
      else if (act === "agents") openAgentsModal();
      else if (act === "fullscreen") void toggleFullscreen();
      return;
    }

    switch (el.getAttribute("data-m")) {
      case "drawer":
        document.body.classList.remove("m-sheet-open");
        document.body.classList.toggle("m-drawer-open");
        break;
      case "new":
        closeMobileOverlays();
        openNewTerminalModal();
        break;
      case "menu":
        document.body.classList.remove("m-drawer-open");
        document.body.classList.toggle("m-sheet-open");
        break;
      case "scrim":
        closeMobileOverlays();
        break;
    }
  });

  bindGlobalMobileListeners();

  createIcons({ icons: lucideIcons });
  syncMobileChrome();
}

type ChatWorkspaceSidebarGroup = {
  id: string;
  label: string;
  path: string | null;
  terminals: TerminalSession[];
  discussions: DiscussionSummary[];
};

// Tous les dossiers restent visibles et leurs conversations sont rangees juste
// dessous.
const chatWorkspaceSidebarGroups = (): ChatWorkspaceSidebarGroup[] => {
  const groups = new Map<string, ChatWorkspaceSidebarGroup>();
  const closedIds = closedWorkspaceIds();
  knownWorkspaces().forEach((workspace) => {
    groups.set(workspace.id, {
      id: workspace.id,
      label: workspace.label,
      path: workspace.path,
      terminals: [],
      discussions: [],
    });
  });

  let unknown: ChatWorkspaceSidebarGroup | null = null;
  allDiscussions().forEach((discussion) => {
    const path = discussionFolderPath(discussion);
    if (!path) {
      unknown ??= {
        id: WORKSPACE_UNKNOWN,
        label: "Sans environnement",
        path: null,
        terminals: [],
        discussions: [],
      };
      unknown.discussions.push(discussion);
      return;
    }

    const id = workspaceIdForPath(path);
    if (closedIds.has(id)) return;
    let group = groups.get(id);
    if (!group) {
      group = {
        id,
        label: workspaceBaseName(path),
        path,
        terminals: [],
        discussions: [],
      };
      groups.set(id, group);
    }
    group.discussions.push(discussion);
  });

  terminalSessions.forEach((session) => {
    const path = session.folderPath?.trim();
    if (!path) {
      unknown ??= {
        id: WORKSPACE_UNKNOWN,
        label: "Sans environnement",
        path: null,
        terminals: [],
        discussions: [],
      };
      unknown.terminals.push(session);
      return;
    }

    const id = workspaceIdForPath(path);
    if (closedIds.has(id)) return;
    let group = groups.get(id);
    if (!group) {
      group = {
        id,
        label: workspaceBaseName(path),
        path,
        terminals: [],
        discussions: [],
      };
      groups.set(id, group);
    }
    group.terminals.push(session);
  });

  const result = [...groups.values()];
  if (unknown) result.push(unknown);
  return result;
};

const compactWorkspaceId = (session: TerminalSession): string => {
  const id = session.workspaceId?.trim();
  if (!id) return session.running ? "preparation" : "en attente";
  return id.length > 12 ? id.slice(-8) : id;
};

const terminalSearchValues = (session: TerminalSession): string[] => {
  const agent = agentById(session.agentId);
  const account = accountById(session.accountId);
  return [
    terminalTitle(session),
    session.status,
    agent?.label ?? session.agentId,
    account?.label ?? session.accountId,
    session.folderPath ?? "",
    session.workspaceId ?? "",
    session.workspacePath ?? "",
  ];
};

const renderFolderTerminalGroups = (sessions: TerminalSession[]): string => {
  if (!sessions.length) return `<div class="chat-workspace-empty">Aucun terminal</div>`;
  const byAgent = new Map<string, TerminalSession[]>();
  sessions.forEach((session) => {
    const list = byAgent.get(session.agentId) ?? [];
    list.push(session);
    byAgent.set(session.agentId, list);
  });

  return [...byAgent.entries()]
    .map(([agentId, agentSessions]) => {
      const agentLabel = agentById(agentId)?.label ?? agentId;
      const items = agentSessions
        .sort((left, right) => (right.startedAtUnix ?? 0) - (left.startedAtUnix ?? 0))
        .map((session) => {
          const workspaceDetail = session.workspacePath ?? "Workspace physique en preparation";
          return `<button type="button" class="chat-folder-terminal ${session.key === activeTerminalKey ? "active" : ""}" data-open-folder-terminal="${escapeAttr(session.key)}" title="${escapeAttr(workspaceDetail)}">
            <span class="live-dot ${session.running ? "on" : ""}"></span>
            <span class="chat-folder-terminal-copy">
              <strong>${escapeHtml(terminalTitle(session))}</strong>
              <small>${escapeHtml(session.status)} · WS ${escapeHtml(compactWorkspaceId(session))}</small>
            </span>
            <i data-lucide="square-terminal"></i>
          </button>`;
        })
        .join("");
      return `<section class="chat-folder-agent-group">
        <header><span><i data-lucide="bot"></i>${escapeHtml(agentLabel)}</span><b>${agentSessions.length}</b></header>
        ${items}
      </section>`;
    })
    .join("");
};

const renderChatSidebarConversations = (): string => {
  const query = chatSidebarSearch.trim().toLocaleLowerCase();
  const environmentPath = userEnvironmentPath(currentWorkspace());

  if (!environmentPath) {
    return `<button type="button" class="chat-side-empty chat-side-choose-environment" id="chooseEnvironmentFromSidebar">
      <i data-lucide="folders"></i>
      <strong>Choisir un environnement</strong>
      <small>Les chats et les agents apparaitront ici.</small>
    </button>`;
  }

  if (!discussionsLoaded && terminalSessions.length === 0) {
    return `<div class="chat-side-empty"><span class="chat-loader"></span>Chargement…</div>`;
  }

  const environmentId = workspaceIdForPath(environmentPath);
  const discussions = allDiscussions()
    .filter((discussion) => {
      const path = discussionFolderPath(discussion);
      return !!path && workspaceIdForPath(path) === environmentId;
    })
    .filter((discussion) => {
      if (!query) return true;
      return [
        discussion.title ?? "",
        discussion.preview ?? "",
        discussion.accountLabel,
        providerLabel(discussion.provider ?? "codex"),
      ].some((value) => value.toLocaleLowerCase().includes(query));
    })
    .sort((left, right) => right.lastActivity - left.lastActivity);

  const conversationItems = discussions
    .map((discussion) => {
      const openedPane = expertChatPanes.find(
        (pane) => pane.discussion?.sessionId === discussion.sessionId,
      );
      const current = openedPane?.key === activeExpertChatKey;
      const title = discussion.title?.trim() || "Conversation sans titre";
      const busy = discussionBusyId === discussion.sessionId;
      return `<div class="chat-side-item ${openedPane ? "active" : ""} ${current ? "current" : ""} ${busy ? "moving" : ""}" aria-busy="${busy}">
        <button type="button" class="chat-side-open" data-open-chat="${escapeAttr(discussion.sessionId)}" title="${escapeAttr(title)}">
          <span class="chat-side-active"></span>
          <i class="chat-side-terminal-icon" data-lucide="message-square"></i>
          <span class="chat-side-copy">
            <strong>${escapeHtml(title)}</strong>
            <small>${escapeHtml(discussion.accountLabel)} · ${escapeHtml(providerLabel(discussion.provider ?? "codex"))}</small>
          </span>
        </button>
        <button type="button" class="chat-side-delete" data-delete-session="${escapeAttr(discussion.sessionId)}" title="Supprimer la conversation" aria-label="Supprimer ${escapeAttr(title)}">
          <i data-lucide="trash-2"></i>
        </button>
      </div>`;
    })
    .join("");

  // La grille de chats compte chaque pane ouvert de l'environnement (y compris
  // un nouveau chat sans premier message, ou un chat dont la discussion n'a pas
  // de dossier resolu). La barre laterale doit refleter la meme source de verite
  // sinon elle affiche « Aucun chat » alors qu'un chat est bien actif. La
  // recherche ne cible que les discussions persistees : un brouillon n'a pas
  // encore de texte a filtrer.
  const draftPanes = query
    ? []
    : draftEnvironmentChatPanes(
        expertChatPanesForCurrentEnvironment(),
        discussions.map((discussion) => discussion.sessionId),
      );

  const draftItems = draftPanes
    .map((pane) => {
      const current = pane.key === activeExpertChatKey;
      const account = expertChatSelectedAccount(pane);
      const title = pane.discussion?.title?.trim() || "Nouveau chat";
      const subtitle = account
        ? `${account.label} · ${providerLabel(accountProvider(account))}`
        : "Choisissez un agent";
      return `<div class="chat-side-item active ${current ? "current" : ""}">
        <button type="button" class="chat-side-open" data-open-pane="${escapeAttr(pane.key)}" title="${escapeAttr(title)}">
          <span class="chat-side-active"></span>
          <i class="chat-side-terminal-icon" data-lucide="message-square-plus"></i>
          <span class="chat-side-copy">
            <strong>${escapeHtml(title)}</strong>
            <small>${escapeHtml(subtitle)}</small>
          </span>
        </button>
        <button type="button" class="chat-side-delete" data-close-pane="${escapeAttr(pane.key)}" title="Fermer ce chat" aria-label="Fermer ${escapeAttr(title)}">
          <i data-lucide="x"></i>
        </button>
      </div>`;
    })
    .join("");

  const totalCount = discussions.length + draftPanes.length;
  const listItems = `${draftItems}${conversationItems}`;

  return `<section class="chat-workspace-group active chat-current-environment-chats">
    <div class="chat-folder-section-label"><span>Chats de cet environnement</span><b>${totalCount}</b></div>
    <div class="chat-workspace-terminals">
      ${listItems || `<div class="chat-workspace-empty">${query ? "Aucun resultat" : "Aucun chat. Ouvrez-en un avec l'agent de votre choix."}</div>`}
    </div>
  </section>`;
};

// Signature legere de l'en-tete : evite tout churn DOM au poll quand les
// workspaces et le nombre total de conversations n'ont pas change.
const workspaceSwitcherSignature = (): string => {
  const all = allDiscussions();
  const counts = new Map<string, number>();
  all.forEach((discussion) => {
    const folderPath = discussionFolderPath(discussion);
    if (folderPath) {
      const id = workspaceIdForPath(folderPath);
      counts.set(id, (counts.get(id) ?? 0) + 1);
    }
  });
  const ws = knownWorkspaces()
    .map((workspace) => `${workspace.id}:${counts.get(workspace.id) ?? 0}`)
    .join(",");
  const terminals = terminalSessions
    .map((session) => `${session.key}:${session.folderPath ?? ""}:${session.status}:${session.workspaceId ?? ""}`)
    .join(",");
  return `${all.length}|${ws}|${terminals}`;
};

// Le seul point d'entree pour changer de contexte : le menu d'environnement
// reste separe des conversations de l'environnement actif.
const renderWorkspaceSwitcher = (): string => {
  const environmentPath = userEnvironmentPath(currentWorkspace());
  const environment = environmentPath
    ? knownWorkspaces().find((workspace) => workspace.id === workspaceIdForPath(environmentPath))
    : null;
  const label = environment?.label ?? (environmentPath ? workspaceBaseName(environmentPath) : "Choisir un environnement");
  const detail = environmentPath ?? "Chats, agents et collaboration";

  return `
    <section class="chat-workspace-overview" id="chatWsSwitcher" data-ws-sig="${escapeAttr(workspaceSwitcherSignature())}">
      <button type="button" id="wsOpenFolder" class="chat-environment-selector" title="Changer d'environnement avec la touche accent grave" aria-label="Choisir un environnement">
        <span class="chat-workspace-overview-mark"><i data-lucide="folders"></i></span>
        <span class="chat-workspace-overview-copy">
          <small>Environnement</small>
          <strong>${escapeHtml(label)}</strong>
          <small>${escapeHtml(detail)}</small>
        </span>
        <kbd aria-label="Raccourci accent grave">&#96;</kbd>
        <i data-lucide="chevrons-up-down"></i>
      </button>
      ${environmentPath
        ? `<button type="button" id="workspaceLiveGraph" class="chat-workspace-add workspace-live-launch" title="Voir l'activité temps réel de l'environnement" aria-label="Activité temps réel de l'environnement">
          <i data-lucide="activity"></i>
        </button>`
        : ""}
    </section>`;
};

const appViewTitle = (view: AppView): string => {
  switch (view) {
    case "terminal":
      return terminalFolderFilter
        ? `Terminaux · ${workspaceBaseName(terminalFolderFilter)}`
        : "Choisir un environnement";
    case "pool":
      return "Comptes et pool";
    case "limits":
      return "Limites";
    case "dashboard":
      return "Statistiques";
    case "kombai":
      return "Kombai";
    case "discussions":
      return "Toutes les conversations";
    case "history":
      return "Historique";
    case "room":
      return "Collaboration de l'environnement";
    case "audit":
      return "Audit de l'interface";
    case "skills":
      return "Bibliotheque de skills";
    case "settings":
      return "Paramètres";
    default:
      return "Conversation";
  }
};

// Page « Paramètres » : regroupe la configuration de l'app. Le compte/pool
// (anciennement dans la barre latérale) vit désormais ici ; l'entrée latérale
// affiche à la place « Discussions » (reprise d'une conversation dans un autre
// compte). Chaque carte ouvre la vue/modale dédiée existante.
const renderSettingsPanel = (): string => {
  const accountCount = settings?.accounts.length ?? 0;
  const poolRunning = poolStatus?.running ?? false;
  return `
    <div class="panel settings-panel">
      <div class="panel-head">
        <div>
          <h2>Paramètres</h2>
          <p class="panel-sub">Comptes, pool et configuration de l'application</p>
        </div>
      </div>
      <div class="settings-cards">
        <button type="button" id="settingsAccounts" class="settings-card">
          <span class="settings-card-icon"><i data-lucide="server"></i></span>
          <span class="settings-card-copy">
            <strong>Comptes &amp; pool</strong>
            <small>${accountCount} compte(s) · pool ${poolRunning ? "actif" : "arrêté"}</small>
          </span>
        </button>
        <button type="button" id="settingsAgents" class="settings-card">
          <span class="settings-card-icon"><i data-lucide="bot"></i></span>
          <span class="settings-card-copy">
            <strong>Réglages des agents</strong>
            <small>Fournisseurs, modèles et commandes de lancement</small>
          </span>
        </button>
      </div>
    </div>`;
};

const renderActiveAppPanel = (): string => {
  switch (activeView) {
    case "terminal":
      return renderExpertTerminalGrid();
    case "pool":
      return renderAccountsAndPool();
    case "limits":
      return renderLimitsPanel();
    case "dashboard":
      return renderDashboardPanel();
    case "kombai":
      return renderKombaiPanel();
    case "discussions":
      return renderDiscussionsPanel();
    case "history":
      return renderPromptHistoryPanel();
    case "room":
      return renderRoomPanel();
    case "audit":
      return renderAuditPanel();
    case "skills":
      return renderSkillsPanel();
    case "settings":
      return renderSettingsPanel();
    default:
      return renderChatPanel(chatPanelModel());
  }
};

const renderTerminalEnvironmentMenu = (): string => {
  if (!terminalEnvironmentMenuOpen) return "";
  const activePath = userEnvironmentPath(currentWorkspace());
  const activeId = activePath ? workspaceIdForPath(activePath) : null;
  const sidebarGroups = chatWorkspaceSidebarGroups();
  const environments = terminalEnvironmentGroups()
    .map((group) => {
      const id = workspaceIdForPath(group.path);
      const active = id === activeId;
      const discussionCount = sidebarGroups.find((candidate) => candidate.id === id)?.discussions.length ?? 0;
      const draftPanes = expertChatPanes.filter((pane) => {
        const panePath = expertChatPaneEnvironmentPath(pane);
        return !pane.discussion && !!panePath && workspaceIdForPath(panePath) === id;
      });
      const agentIds = new Set([
        ...(sidebarGroups.find((candidate) => candidate.id === id)?.discussions.map((discussion) => discussion.accountId) ?? []),
        ...draftPanes.map((pane) => pane.accountId).filter((accountId): accountId is string => !!accountId),
        ...group.sessions.map((session) => session.accountId),
      ]);
      const chatCount = discussionCount + draftPanes.length;
      const deleting = workspaceClosingId === id;
      return `<div class="terminal-environment-menu-row">
        <button
          type="button"
          class="terminal-environment-menu-item ${active ? "active" : ""}"
          data-environment-menu-id="${escapeAttr(id)}"
          aria-current="${active ? "true" : "false"}"
          title="${escapeAttr(group.path)}"
        >
          <span class="terminal-environment-menu-icon"><i data-lucide="folder${active ? "-open" : ""}"></i></span>
          <span class="terminal-environment-menu-copy">
            <strong>${escapeHtml(group.label)}</strong>
            <small>${escapeHtml(group.path)}</small>
          </span>
          <span class="terminal-environment-menu-state">
            <b>${chatCount} chat${chatCount > 1 ? "s" : ""}</b>
            <small>${agentIds.size} agent${agentIds.size > 1 ? "s" : ""}</small>
          </span>
          <i data-lucide="chevron-right"></i>
        </button>
        <button
          type="button"
          class="terminal-environment-menu-delete"
          data-delete-environment-id="${escapeAttr(id)}"
          title="Supprimer l'environnement ${escapeAttr(group.label)} de Switch"
          aria-label="Supprimer l'environnement ${escapeAttr(group.label)}"
          ${deleting ? "disabled" : ""}
        >
          <i data-lucide="trash-2"></i>
        </button>
      </div>`;
    })
    .join("");

  return `<div class="modal-backdrop terminal-environment-menu-backdrop" id="terminalEnvironmentMenuBackdrop">
    <section class="terminal-environment-menu" role="dialog" aria-modal="true" aria-labelledby="terminalEnvironmentMenuTitle">
      <header class="terminal-environment-menu-head">
        <span class="terminal-environment-menu-mark"><i data-lucide="folders"></i></span>
        <span>
          <h2 id="terminalEnvironmentMenuTitle">Choisir un environnement</h2>
          <p>Un environnement regroupe ses chats, ses agents et leur collaboration.</p>
        </span>
        <kbd aria-label="Raccourci accent grave">&#96;</kbd>
        <button type="button" class="icon-button" id="closeTerminalEnvironmentMenu" title="Fermer le menu" aria-label="Fermer le menu">
          <i data-lucide="x"></i>
        </button>
      </header>
      <div class="terminal-environment-menu-list">
        ${environments || `<div class="terminal-environment-menu-empty"><i data-lucide="folder-open"></i><strong>Aucun environnement</strong><small>Parcourez les dossiers pour choisir votre premier environnement.</small></div>`}
      </div>
      <footer class="terminal-environment-menu-actions">
        <span><i data-lucide="folder-open"></i>Selectionnez un dossier existant sur votre machine</span>
        <button type="button" class="tool-button primary" id="createEnvironmentFromMenu" title="Afficher les dossiers et parcourir l'arborescence">
          <i data-lucide="folder-open"></i><span>Parcourir les dossiers</span>
        </button>
      </footer>
    </section>
  </div>`;
};

const renderExpertTerminalGrid = () => {
  const folderPath = userEnvironmentPath(terminalFolderFilter);
  if (!folderPath) {
    return `<section class="terminal-environment-gate" data-folder-terminal-view="unselected">
      <div class="terminal-environment-gate-card">
        <span class="terminal-environment-gate-icon"><i data-lucide="folders"></i></span>
        <strong>Choisis d'abord un environnement</strong>
        <p>Les terminaux s'ouvriront ensuite dans l'environnement actif.</p>
        <button type="button" id="chooseTerminalEnvironment" class="tool-button primary">
          <i data-lucide="folder-open"></i><span>Choisir l'environnement</span>
        </button>
      </div>
    </section>`;
  }

  const sessions = expertTerminalSessions();
  const folderProfile = folderPath
    ? knownWorkspaces().find((workspace) => workspace.id === workspaceIdForPath(folderPath))
    : null;
  const folderLabel = folderProfile?.label ?? workspaceBaseName(folderPath);
  const agentCounts = new Map<string, number>();
  sessions.forEach((session) => {
    agentCounts.set(session.agentId, (agentCounts.get(session.agentId) ?? 0) + 1);
  });
  const agentChips = [...agentCounts.entries()]
    .map(([agentId, count]) => `<span><i data-lucide="bot"></i>${escapeHtml(agentById(agentId)?.label ?? agentId)} <b>${count}</b></span>`)
    .join("");
  if (expertTerminalFullscreenKey && !sessions.some((session) => session.key === expertTerminalFullscreenKey)) {
    expertTerminalFullscreenKey = null;
  }
  const slotCount = Math.max(2, sessions.length);
  const columns = expertGridColumnCount(slotCount);
  const rows = Math.ceil(slotCount / columns);
  const chatSidebarHidden = displayedChatSidebarWidth() === 0;
  const panes = sessions
    .map((session, index) => {
      const sessionAgentLabel = agentById(session.agentId)?.label ?? session.agentId;
      const workspaceLabel = `WS ${compactWorkspaceId(session)}`;
      const workspaceDetail = session.workspacePath ?? "Workspace physique en preparation";
      return `
        <article class="expert-terminal-pane ${session.key === activeTerminalKey ? "active" : ""} ${session.running ? "running" : ""} ${session.key === expertTerminalFullscreenKey ? "is-fullscreen" : ""}" data-expert-terminal-pane="${escapeAttr(session.key)}">
          <header class="expert-terminal-pane-head">
            <button type="button" class="expert-pane-identity" data-focus-terminal="${escapeAttr(session.key)}" title="${escapeAttr(`${workspaceDetail} · Survolez puis appuyez sur la barre d'espace pour agrandir`)}">
              <span class="expert-pane-index">${index + 1}</span>
              <span class="live-dot ${session.running ? "on" : ""}"></span>
              <span class="expert-pane-copy">
                <strong>${escapeHtml(terminalTitle(session))}</strong>
                <small>${escapeHtml(`${sessionAgentLabel} · ${workspaceLabel}`)}</small>
              </span>
            </button>
            <span class="expert-pane-status">${escapeHtml(session.ptyId ? `PTY ${session.ptyId}` : session.status)}</span>
            <button type="button" class="expert-pane-toggle-chat" data-toggle-chat-sidebar title="${chatSidebarHidden ? "Afficher la fenêtre de chat" : "Masquer la fenêtre de chat"}" aria-label="${chatSidebarHidden ? "Afficher la fenêtre de chat" : "Masquer la fenêtre de chat"}" aria-pressed="${!chatSidebarHidden}">
              <i data-lucide="${chatSidebarHidden ? "panel-left-open" : "panel-left-close"}"></i>
            </button>
            <button type="button" class="expert-pane-fullscreen" data-toggle-terminal-fullscreen="${escapeAttr(session.key)}" title="${session.key === expertTerminalFullscreenKey ? "Quitter le plein ecran" : "Afficher ce terminal en plein ecran"}" aria-label="${session.key === expertTerminalFullscreenKey ? "Quitter le plein ecran" : "Afficher ce terminal en plein ecran"}" aria-pressed="${session.key === expertTerminalFullscreenKey}">
              <i data-lucide="${session.key === expertTerminalFullscreenKey ? "minimize-2" : "maximize-2"}"></i>
            </button>
            <button type="button" class="expert-pane-close" data-close-terminal="${escapeAttr(session.key)}" title="Fermer ce terminal" aria-label="Fermer ${escapeAttr(terminalTitle(session))}">
              <i data-lucide="x"></i>
            </button>
          </header>
          <div class="expert-terminal-host" data-terminal-host="${escapeAttr(session.key)}"></div>
        </article>
      `;
    })
    .join("");
  const emptySlots = Array.from({ length: Math.max(0, columns * rows - sessions.length) }, (_, index) => `
    <button type="button" class="expert-terminal-empty" data-add-expert-terminal ${terminalSessions.length >= EXPERT_MAX_TERMINALS ? "disabled" : ""}>
      <span class="expert-empty-icon"><i data-lucide="plus"></i></span>
      <strong>${sessions.length === 0 && index === 0 ? "Ouvrir le premier terminal" : "Ajouter un terminal"}</strong>
      <small>Agent au choix dans cet environnement</small>
    </button>
  `).join("");

  return `
    <section class="folder-terminal-panel" data-folder-terminal-view="${escapeAttr(folderPath)}">
      <header class="folder-terminal-head">
        <span class="folder-terminal-mark"><i data-lucide="folder-open"></i></span>
        <span class="folder-terminal-copy">
          <strong>${escapeHtml(folderLabel)}</strong>
          <small>${escapeHtml(folderPath ?? "Tous les environnements ouverts")}</small>
        </span>
        <span class="folder-terminal-stats">
          <b>${sessions.length}</b> terminaux · <b>${agentCounts.size}</b> agents
        </span>
        <span class="folder-terminal-actions">
          <button type="button" id="folderNewChat" class="tool-button" title="Nouvelle conversation dans cet environnement"><i data-lucide="messages-square"></i><span>Chat</span></button>
          <button type="button" id="folderNewTerminal" class="tool-button primary" title="Nouveau terminal dans ${escapeAttr(folderLabel)}" ${terminalSessions.length >= EXPERT_MAX_TERMINALS ? "disabled" : ""}><i data-lucide="square-terminal"></i><span>Terminal</span></button>
        </span>
      </header>
      <div class="folder-agent-summary">
        <span class="folder-isolation-chip"><i data-lucide="folder-open"></i>Environnement actif</span>
        ${agentChips}
      </div>
      <div class="expert-terminal-wall" style="--expert-columns: ${columns}; --expert-rows: ${rows}" aria-label="Mur de ${sessions.length} terminaux">
        ${panes}${emptySlots}
      </div>
    </section>
  `;
};

const renderExpertChatGrid = () => {
  const environmentPath = userEnvironmentPath(currentWorkspace());
  if (!environmentPath) {
    return `<section class="chat-environment-gate">
      <span><i data-lucide="folders"></i></span>
      <h2>Choisissez un environnement</h2>
      <p>Vous pourrez ensuite y ouvrir plusieurs chats avec des agents differents.</p>
      <button type="button" id="chooseEnvironmentFromChat" class="tool-button primary">
        <i data-lucide="chevrons-up-down"></i><span>Choisir un environnement</span>
      </button>
    </section>`;
  }
  const environmentPanes = expertChatPanesForCurrentEnvironment();
  const count = environmentPanes.length;
  expertChatPage = clampExpertChatPage(expertChatPage, count, expertChatsPerPage);
  const totalPages = expertChatPageTotal();
  const pagePanes = visibleExpertChatPanes();
  const columns = expertChatColumnCount(expertChatsPerPage);
  const rows = expertChatRowCount(expertChatsPerPage);
  const firstVisible = count ? expertChatPage * expertChatsPerPage + 1 : 0;
  const lastVisible = expertChatPage * expertChatsPerPage + pagePanes.length;
  const environment = knownWorkspaces().find(
    (workspace) => workspace.id === workspaceIdForPath(environmentPath),
  );
  const environmentLabel = environment?.label ?? workspaceBaseName(environmentPath);
  const hasAccounts = (settings?.accounts?.length ?? 0) > 0;
  return `
    <section class="expert-chat-workspace" aria-label="${count} chats ouverts, page ${expertChatPage + 1} sur ${totalPages}" title="Dans un chat : Retour arrière : fermer · Suppr : fermer avec la discussion">
      <header class="expert-chat-toolbar">
        <div>
          <span class="expert-chat-toolbar-mark"><i data-lucide="folder-open"></i></span>
          <span><strong>${escapeHtml(environmentLabel)}</strong><small>${escapeHtml(environmentPath)}</small></span>
        </div>
        <div class="expert-chat-toolbar-actions">
          <span class="expert-chat-count"><strong>${count}</strong> chat${count > 1 ? "s" : ""}</span>
          <label class="expert-grid-control expert-page-size-control" title="Nombre de chats affiches sur chaque page">
            <span><i data-lucide="app-window"></i><small>Par page</small></span>
            <select id="expertChatPageSize" aria-label="Nombre de chats par page">
              <option value="6" ${expertChatsPerPage === 6 ? "selected" : ""}>6 chats</option>
              <option value="9" ${expertChatsPerPage === 9 ? "selected" : ""}>9 chats</option>
              <option value="12" ${expertChatsPerPage === 12 ? "selected" : ""}>12 chats</option>
              <option value="16" ${expertChatsPerPage === 16 ? "selected" : ""}>16 chats</option>
            </select>
          </label>
          <nav class="expert-chat-pagination" aria-label="Pages de chats">
            <button id="expertChatPrevPage" type="button" ${expertChatPage === 0 ? "disabled" : ""} title="Page precedente" aria-label="Page precedente">
              <i data-lucide="chevron-left"></i>
            </button>
            <span aria-live="polite" title="Chats ${firstVisible} a ${lastVisible} sur ${count}"><strong>${expertChatPage + 1}</strong><small>/ ${totalPages}</small></span>
            <button id="expertChatNextPage" type="button" ${expertChatPage + 1 >= totalPages ? "disabled" : ""} title="Page suivante" aria-label="Page suivante">
              <i data-lucide="chevron-right"></i>
            </button>
          </nav>
          <button type="button" data-open-discussions class="tool-button resume-discussion-button" title="Choisir une discussion a reprendre">
            <i data-lucide="messages-square"></i><span>Reprendre une discussion</span>
          </button>
          <button id="openEnvironmentCollaboration" type="button" class="tool-button" title="Ouvrir l'espace ou les agents de cet environnement se parlent">
            <i data-lucide="users"></i><span>Collaboration</span>
          </button>
          <button id="addExpertChat" type="button" class="tool-button primary" title="Ouvrir un nouveau chat dans cet environnement" ${hasAccounts ? "" : "disabled"}>
            <i data-lucide="plus"></i><span>Ouvrir un chat</span>
          </button>
        </div>
      </header>
      <div class="expert-chat-wall" style="--expert-chat-columns: ${columns}; --expert-chat-rows: ${rows}" aria-label="Chats ${firstVisible} a ${lastVisible}">
        ${pagePanes.map(renderExpertChatPane).join("") || `<div class="expert-chat-environment-empty"><i data-lucide="bot"></i><strong>Aucun chat ouvert</strong><small>Choisissez un agent puis ouvrez un chat.</small></div>`}
      </div>
    </section>`;
};

const renderChatFirstShell = () => {
  const isChat = activeView === "chat";
  const environmentChatCount = expertChatPanesForCurrentEnvironment().length;
  const visibleSidebarWidth = displayedChatSidebarWidth();
  const sidebarMaxWidth = chatSidebarMaxWidth(window.innerWidth);
  const activeWorkspacePath = currentWorkspace();
  const newChatTitle = activeWorkspacePath
    ? `Nouvelle conversation dans ${workspaceBaseName(activeWorkspacePath)}`
    : "Nouvelle conversation dans un environnement a choisir";
  captureAllExpertChatScroll();
  document.querySelector(".m-chrome")?.remove();
  document.body.classList.remove("m-drawer-open", "m-sheet-open", "chat-sidebar-resizing");

  app.innerHTML = `
    <div class="layout chat-app-layout ${isChat ? "is-chat" : "is-admin"} ${visibleSidebarWidth === 0 ? "is-sidebar-collapsed" : ""}" style="--chat-sidebar-width: ${visibleSidebarWidth}px">
      <aside class="sidebar chat-app-sidebar" id="chatAppSidebar">
        <header class="chat-side-brand">
          <button type="button" id="chatHome" class="chat-brand-button" title="Accueil des conversations">
            <span class="chat-brand-mark"><i data-lucide="sparkles"></i></span>
            <span><strong>Switch</strong><small>Agent d'environnement</small></span>
          </button>
          <button type="button" id="chatSidebarClose" class="icon-button chat-sidebar-close" aria-label="Fermer le menu"><i data-lucide="x"></i></button>
        </header>

        ${renderWorkspaceSwitcher()}

        <button type="button" id="newChatSide" class="chat-side-new" title="${escapeAttr(newChatTitle)}">
          <i data-lucide="plus"></i><span>Nouveau chat</span><kbd>${environmentChatCount}</kbd>
        </button>
        <label class="chat-side-search">
          <i data-lucide="search"></i>
          <input id="chatSidebarSearch" type="search" value="${escapeAttr(chatSidebarSearch)}" placeholder="Rechercher dans cet environnement" aria-label="Rechercher dans l'environnement actif" />
        </label>
        <nav class="chat-side-conversations" id="chatSideConversations" aria-label="Chats de l'environnement actif">${renderChatSidebarConversations()}</nav>

        <nav class="chat-side-tools" aria-label="Outils">
          <button id="sideDiscussions" class="${activeView === "discussions" ? "active" : ""}" title="Discussions — reprendre une conversation dans un autre compte"><i data-lucide="messages-square"></i><span>Discussions</span></button>
          <button id="dashboardToggle" class="${activeView === "dashboard" ? "active" : ""}" title="Statistiques"><i data-lucide="bar-chart-3"></i><span>Stats</span></button>
          <button id="limitsToggle" class="${activeView === "limits" ? "active" : ""}" title="Limites"><i data-lucide="calendar-clock"></i><span>Limites</span></button>
          <button id="roomToggle" class="${activeView === "room" ? "active" : ""}" title="Collaboration de l'environnement"><i data-lucide="users"></i><span>Collab</span></button>
          <button id="skillsToggle" class="${activeView === "skills" ? "active" : ""}" title="Skills"><i data-lucide="library"></i><span>Skills</span></button>
        </nav>

        <footer class="chat-side-footer">
          <button id="settingsToggle" class="icon-button ${activeView === "settings" ? "active" : ""}" title="Paramètres (comptes, pool)"><i data-lucide="settings"></i></button>
          <button id="manageAgents" class="icon-button" title="Reglages des agents"><i data-lucide="bot"></i></button>
        </footer>
      </aside>
      <div
        id="chatSidebarResizer"
        class="chat-sidebar-resizer"
        role="separator"
        tabindex="0"
        aria-label="Redimensionner la colonne des conversations"
        aria-orientation="vertical"
        aria-controls="chatAppSidebar chatMainWorkspace"
        aria-valuemin="${CHAT_SIDEBAR_MIN_WIDTH}"
        aria-valuemax="${sidebarMaxWidth}"
        aria-valuenow="${visibleSidebarWidth}"
        aria-valuetext="${visibleSidebarWidth === 0 ? "Colonne masquée" : `${visibleSidebarWidth} pixels`}"
        title="Faire glisser pour redimensionner · Double-cliquer pour réinitialiser"
      ></div>
      <button type="button" id="chatSidebarScrim" class="chat-sidebar-scrim" aria-label="Fermer le menu"></button>

      <main class="workspace chat-main-workspace" id="chatMainWorkspace">
        ${isChat
          ? renderExpertChatGrid()
          : `<header class="chat-admin-head">
              <button type="button" id="adminBackChat" class="icon-button"><i data-lucide="arrow-left"></i></button>
              <div><strong>${escapeHtml(appViewTitle(activeView))}</strong><span>${escapeHtml(statusText)}</span></div>
              <div class="chat-admin-actions">
                ${activeView !== "discussions" ? `<button id="discussionsToggle" type="button" data-open-discussions class="tool-button" title="Choisir une discussion a reprendre"><i data-lucide="messages-square"></i><span>Reprendre une discussion</span></button>` : ""}
                <button id="kombaiToggle" class="icon-button" title="Kombai"><i data-lucide="bot"></i></button>
                <button id="historyToggle" class="icon-button" title="Historique"><i data-lucide="history"></i></button>
                <button id="auditToggle" class="icon-button" title="Audit"><i data-lucide="scan-eye"></i></button>
              </div>
            </header>
            <section class="terminal-shell chat-admin-panel">${renderActiveAppPanel()}</section>`}
        <div class="chat-status-toast" aria-live="polite">${escapeHtml(statusText)}</div>
      </main>
    </div>
    ${renderNewChatModal()}
    ${renderNewTerminalModal()}
    ${renderAgentsModal()}
    ${renderWorkspaceModal()}
    ${renderTerminalEnvironmentMenu()}
    ${renderWorkspaceLiveGraphModal()}
    ${renderCodexModelSuggestions()}
  `;

  createIcons({ icons: lucideIcons });
  bindUi();
  bindExpertChatGridUi();
  if (activeView === "terminal") mountExpertTerminals();
};

const render = () => {
  if (draggedChatSessionId) clearChatDragUi();
  if (!settings) {
    app.innerHTML = `<main class="boot">Chargement</main>`;
    return;
  }

  const activeEl = document.activeElement;
  focusedTerminalKeyBeforeRender =
    (activeEl &&
      terminalSessions.find((session) => session.terminal.element?.contains(activeEl))?.key) ||
    null;

  // Preserve la position de defilement des vues admin (Comptes & pool, limites,
  // stats…). renderChatFirstShell remplace tout le DOM (app.innerHTML), ce qui
  // remettrait sinon le scroll a 0 et "ferait remonter" l'utilisateur a chaque
  // re-rendu — tres visible en supprimant un compte en bas de page.
  const adminScrollTop =
    document.querySelector<HTMLElement>(".chat-admin-panel")?.scrollTop ?? 0;

  terminalSessions.forEach((session) => {
    const element = session.terminal.element;
    element?.parentElement?.removeChild(element);
  });

  renderChatFirstShell();

  if (adminScrollTop > 0) {
    const restoredAdminPanel = document.querySelector<HTMLElement>(".chat-admin-panel");
    if (restoredAdminPanel) restoredAdminPanel.scrollTop = adminScrollTop;
  }
};

// Ancienne coque plein ecran des terminaux, conservee pour les outils PTY
// historiques. L'interface principale n'utilise plus cette coque.
const renderLegacyTerminalShell = () => {
  if (!settings || !app) return;

  const account = selectedAccount();
  const proxiesEnabled = proxyControlsEnabled();
  const proxy = selectedProxy();
  const activeSession = activeTerminal();
  const activeRunning = activeSession?.running ?? false;
  const terminalActionReturnsToGrid = activeView !== "terminal";
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
  const contextProject = displayProjectDir(
    activeSession?.workspacePath ?? activeSession?.folderPath ?? activeSession?.projectDir ?? account?.projectDir,
  );
  const workspacePath = currentWorkspace();
  const workspaceChipLabel = workspacePath ? workspaceBaseName(workspacePath) : "Environnement";
  const workspaceTitle = workspacePath
    ? `Environnement actif et des prochains terminaux: ${workspacePath}`
    : "Aucun environnement actif: une selection est obligatoire";
  const terminalCountLabel =
    terminalSessions.length === 1 ? "1 terminal" : `${terminalSessions.length} terminaux`;
  const workspaceSideItems = terminalWorkspaceGroups()
    .map((group) => {
      const groupClosed = !!group.path && workspaceIsClosed(group.path);
      const groupActive = group.sessions.some((session) => session.key === activeTerminalKey) ||
        (!activeSession && group.path && workspacePath &&
          normalizeWorkspacePath(group.path) === normalizeWorkspacePath(workspacePath));
      const terminals = group.sessions
        .map((session) => {
          const sessionAgentLabel = agentById(session.agentId)?.label ?? session.agentId;
          return `
        <div class="terminal-side-item ${session.key === activeTerminalKey ? "active" : ""}">
          <button class="terminal-side-button" data-terminal-key="${escapeAttr(session.key)}" title="${escapeAttr(terminalTitle(session))}">
            <i data-lucide="square-terminal"></i>
            <span class="terminal-side-main">
              <span class="terminal-side-title">${escapeHtml(terminalTitle(session))}</span>
              <span class="terminal-side-meta">${escapeHtml(`${session.ptyId ? `#${session.ptyId}` : session.status} · ${sessionAgentLabel}`)}</span>
            </span>
            <span class="live-dot ${session.running ? "on" : ""}"></span>
          </button>
          <button class="terminal-side-close" data-close-terminal="${escapeAttr(session.key)}" title="Fermer terminal">
            <i data-lucide="x"></i>
          </button>
        </div>
      `;
        })
        .join("");
      return `
        <section class="workspace-side-group ${groupActive ? "active" : ""} ${groupClosed ? "closed" : ""}">
          <div class="workspace-side-head">
            <button class="workspace-side-select" data-workspace-key="${escapeAttr(group.key)}" title="${escapeAttr(groupClosed ? `${group.detail} · environnement ferme (cliquer pour rouvrir)` : group.detail)}">
              <i data-lucide="${groupClosed ? "folder-x" : "folder-open"}"></i>
              <span class="workspace-side-copy">
                <strong>${escapeHtml(group.label)}</strong>
                <small>${escapeHtml(groupClosed ? `${group.detail} · ferme` : group.detail)}</small>
              </span>
              <span class="workspace-terminal-count">${group.sessions.length}</span>
            </button>
            ${group.selectable
              ? `<button class="workspace-side-new" data-new-terminal-workspace="${escapeAttr(group.key)}" title="${terminalSessions.length >= EXPERT_MAX_TERMINALS ? "Limite de 16 terminaux atteinte" : `Nouveau terminal dans ${escapeAttr(group.label)}`}" ${terminalSessions.length >= EXPERT_MAX_TERMINALS ? "disabled" : ""}>
                <i data-lucide="plus"></i>
              </button>`
              : ""}
            ${group.path && !groupClosed
              ? `<button class="workspace-side-close" data-close-workspace="${escapeAttr(workspaceIdForPath(group.path))}" title="Fermer l'environnement ${escapeAttr(group.label)}" aria-label="Fermer l'environnement ${escapeAttr(group.label)}">
                <i data-lucide="x"></i>
              </button>`
              : ""}
          </div>
          <div class="terminal-side-list">${terminals || `<div class="workspace-empty">Aucun terminal</div>`}</div>
        </section>
      `;
    })
    .join("");

  app.innerHTML = `
    <div class="layout">
      <aside class="sidebar">
        <header class="brand expert-brand">
          <div class="expert-brand-copy">
            <i data-lucide="square-terminal"></i>
            <span>
              <strong>Switch Terminals</strong>
              <small>${escapeHtml(terminalCountLabel)} · 16 maximum</small>
            </span>
          </div>
        </header>

        <section class="side-section">
          <div class="section-row">
            <span>Environnements</span>
            <span class="section-actions">
              <button class="icon-button" id="workspaceAddSide" title="Choisir ou ajouter un environnement">
                <i data-lucide="folder-open"></i>
              </button>
              <button class="icon-button" id="newTerminalSide" title="${terminalSessions.length >= EXPERT_MAX_TERMINALS ? "Limite de 16 terminaux atteinte" : "Nouveau terminal dans l'environnement actif"}" ${terminalSessions.length >= EXPERT_MAX_TERMINALS ? "disabled" : ""}>
                <i data-lucide="plus"></i>
              </button>
            </span>
          </div>
          <div class="workspace-side-list">${workspaceSideItems}</div>
        </section>
      </aside>

      <main class="workspace">
        <header class="topbar">
          <div class="session-title">
            <span class="live-dot ${activeRunning ? "on" : ""}"></span>
            <div>
              <strong id="expertActiveTitle">${escapeHtml(activeSession ? terminalTitle(activeSession) : (account?.label ?? "Aucun terminal"))}</strong>
              <span id="expertActiveMeta">${escapeHtml(`${contextProxy} | ${contextProject}`)}</span>
            </div>
          </div>
          <div class="actions">
            ${activeView === "terminal"
              ? `<label class="expert-grid-control" title="Disposition du mur de terminaux">
                  <span><i data-lucide="square-terminal"></i><strong>${terminalSessions.length}</strong><small>/ ${EXPERT_MAX_TERMINALS}</small></span>
                  <select id="expertGridLayout" aria-label="Nombre de colonnes">
                    <option value="auto" ${expertGridLayout === "auto" ? "selected" : ""}>Auto</option>
                    <option value="2" ${expertGridLayout === "2" ? "selected" : ""}>2 col.</option>
                    <option value="3" ${expertGridLayout === "3" ? "selected" : ""}>3 col.</option>
                    <option value="4" ${expertGridLayout === "4" ? "selected" : ""}>4 col.</option>
                  </select>
                </label>`
              : ""}
            <div class="workspace-control" title="${escapeAttr(workspaceTitle)}">
              <button id="workspacePick" class="tool-button ${workspacePath ? "primary" : ""}" title="${escapeAttr(workspaceTitle)}">
                <i data-lucide="folder-open"></i>
                <span>${escapeHtml(workspaceChipLabel)}</span>
              </button>
              ${workspacePath
                ? `<button id="workspaceClear" class="icon-button" title="Fermer l'environnement actif" aria-label="Fermer l'environnement actif">
                <i data-lucide="x"></i>
              </button>`
                : ""}
            </div>
            ${workspacePath
              ? `<button id="workspaceLiveGraph" class="tool-button workspace-live-button" title="Activité temps réel de l'environnement">
                <i data-lucide="activity"></i><span>Activité live</span>
              </button>`
              : ""}
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
            <button id="discussionsToggle" data-open-discussions class="tool-button ${activeView === "discussions" ? "primary" : ""}" title="Choisir une discussion a reprendre">
              <i data-lucide="messages-square"></i>
              <span>Reprendre une discussion</span>
            </button>
            <button id="historyToggle" class="tool-button ${activeView === "history" ? "primary" : ""}" title="Historique des demandes (recherche)">
              <i data-lucide="history"></i>
              <span>Historique</span>
            </button>
            <button id="roomToggle" class="tool-button ${activeView === "room" ? "primary" : ""}" title="Collaboration native de l'environnement">
              <i data-lucide="users"></i>
              <span>Collab</span>
            </button>
            <button id="auditToggle" class="tool-button ${activeView === "audit" ? "primary" : ""}" title="Audit design de la vue affichée (détecteur Impeccable)">
              <i data-lucide="scan-eye"></i>
              <span>Audit</span>
            </button>
            <button id="skillsToggle" class="tool-button ${activeView === "skills" ? "primary" : ""}" title="Bibliothèque de skills">
              <i data-lucide="library"></i>
              <span>Skills</span>
            </button>
            <button id="expertTerminalAction" class="tool-button primary" title="${terminalActionReturnsToGrid ? "Revenir au mur de terminaux" : terminalSessions.length >= EXPERT_MAX_TERMINALS ? "Limite de 16 terminaux atteinte" : "Nouveau terminal"}" ${!terminalActionReturnsToGrid && terminalSessions.length >= EXPERT_MAX_TERMINALS ? "disabled" : ""}>
              <i data-lucide="${terminalActionReturnsToGrid ? "square-terminal" : "plus"}"></i>
              <span>${terminalActionReturnsToGrid ? "Terminaux" : "Nouveau"}</span>
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

        <section class="terminal-shell ${activeView === "terminal" ? "expert-terminal-shell" : ""}">
          ${activeView === "terminal"
            ? renderExpertTerminalGrid()
            : activeView === "pool"
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
                          : activeView === "audit"
                            ? renderAuditPanel()
                            : activeView === "skills"
                              ? renderSkillsPanel()
                              : renderChatPanel(chatPanelModel())}
        </section>

        <footer class="statusbar">
          <span>${escapeHtml(statusText)}</span>
          <span>${activeSession?.ptyId ? `PTY #${activeSession.ptyId}` : "PTY inactif"}</span>
        </footer>
      </main>
    </div>
    ${renderNewChatModal()}
    ${renderNewTerminalModal()}
    ${renderAgentsModal()}
    ${renderWorkspaceModal()}
    ${renderTerminalEnvironmentMenu()}
    ${renderWorkspaceLiveGraphModal()}
    ${renderCodexModelSuggestions()}
  `;

  createIcons({ icons: lucideIcons });
  bindUi();
  if (activeView === "terminal") mountExpertTerminals();
  ensureMobileChrome();
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

        <div class="account-editor-stack">
        <section class="account-editor">
          <div class="section-row">
            <span>Compte selectionne</span>
            <div class="account-editor-actions">
              <button id="loginAccount" class="tool-button" title="Ouvrir une fenetre de connexion (login) pour ce compte" ${account ? "" : "disabled"}>
                <i data-lucide="log-in"></i><span>Se connecter</span>
              </button>
              <button id="removeAccount" class="icon-button wide danger" title="Supprimer le compte" ${account ? "" : "disabled"}>
                <i data-lucide="trash-2"></i>
              </button>
            </div>
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
                <button id="pickProjectDir" type="button" class="icon-button" title="Choisir l'environnement projet" ${account && !isRemoteMode() ? "" : "disabled"}>
                  <i data-lucide="folder-open"></i>
                </button>
              </div>
            </label>
            <label>
              <span>Proxy compte</span>
              <select id="proxySelect" ${account && proxiesEnabled ? "" : "disabled"}>${proxyOptions}</select>
            </label>
            <label>
              <span>Modele Codex par defaut</span>
              <input id="accountModel" list="codexModelSuggestions" value="${escapeAttr(accountModel(account))}" ${account ? "" : "disabled"} />
            </label>
            <label>
              <span>Intensite par defaut</span>
              <select id="accountReasoningEffort" ${account ? "" : "disabled"}>${reasoningEffortOptions(accountReasoningEffort(account))}</select>
            </label>
            <label class="toggle" title="Desactive les approbations et la sandbox pour CE compte">
              <input id="accountBypass" type="checkbox" ${(account?.bypass ?? settings.codexBypass ?? true) ? "checked" : ""} ${account ? "" : "disabled"} />
              <span>Mode bypass (sans sandbox)</span>
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
      </div>
    </section>
  `;
};

// Vue « Comptes & pool » : l'editeur complet des comptes (ajout / edition /
// suppression via renderAccountsPanel) en tete, suivi du pool de service. Le
// panneau editeur exige la liste d'options du proxy du compte selectionne, qui
// n'etait construite nulle part depuis que la vue etait cablee sur le seul pool.
// IMPORTANT : les deux panneaux sont enveloppes dans un conteneur unique, car
// `.terminal-shell` est une grille a 2 lignes (auto / 1fr) qui placerait sinon
// chaque <section> dans une ligne differente (editeur ecrase, pool etire).
const renderAccountsAndPool = (): string => {
  if (!settings) return renderPoolPanel();
  const proxiesEnabled = proxyControlsEnabled();
  const account = selectedAccount();
  const proxyOptions = [
    `<option value="">Aucun proxy</option>`,
    ...settings.proxies.map(
      (item) =>
        `<option value="${escapeAttr(item.id)}" ${item.id === account?.proxyId ? "selected" : ""}>${escapeHtml(item.label)}</option>`,
    ),
  ].join("");
  return `<div class="accounts-pool-view">${renderAccountsPanel(proxyOptions, proxiesEnabled)}${renderPoolPanel()}</div>`;
};

const renderNewChatModal = () => {
  if (!settings || !newChatModalOpen) return "";

  const accounts = settings.accounts;
  const account = accountById(newChatAccountId) ?? accounts[0] ?? null;
  const provider = accountProvider(account);
  const environmentPath = userEnvironmentPath(newChatPendingWorkspace ?? currentWorkspace());
  const environmentLabel = environmentPath
    ? knownWorkspaces().find((workspace) => workspace.id === workspaceIdForPath(environmentPath))?.label
      ?? workspaceBaseName(environmentPath)
    : null;
  const modelValue = newChatModel || accountModel(account);

  const accountOptions = accounts
    .map((item) => {
      const selected = item.id === account?.id;
      return `<button
        type="button"
        class="new-chat-account-option ${selected ? "selected" : ""}"
        data-new-chat-account="${escapeAttr(item.id)}"
        role="radio"
        aria-checked="${selected}"
        title="${escapeAttr(item.label)}"
      >
        <span class="new-chat-account-dot" aria-hidden="true"></span>
        <span class="new-chat-account-copy">
          <strong>${escapeHtml(item.label)}</strong>
          <small>${escapeHtml(providerLabel(accountProvider(item)))} · ${escapeHtml(accountModel(item))}</small>
        </span>
        <i data-lucide="${accountProvider(item) === "claude" ? "sparkles" : "cpu"}"></i>
      </button>`;
    })
    .join("");

  return `
    <div class="modal-backdrop" id="newChatBackdrop">
      <section class="modal new-chat-modal" role="dialog" aria-modal="true" aria-labelledby="newChatModalTitle">
        <header class="modal-head">
          <div>
            <h2 id="newChatModalTitle">Nouveau chat</h2>
            <p>${environmentLabel
              ? `Compte, modele et mode pour ce chat dans <strong>${escapeHtml(environmentLabel)}</strong>.`
              : "Choisis le compte, le modele et le mode de ce chat."}</p>
          </div>
          <button class="icon-button" id="closeNewChatModal" title="Fermer" aria-label="Fermer">
            <i data-lucide="x"></i>
          </button>
        </header>

        <div class="modal-body">
          <section class="modal-section">
            <span class="new-chat-field-title">Compte / agent</span>
            ${accounts.length
              ? `<div class="new-chat-account-options" role="radiogroup" aria-label="Compte du nouveau chat">${accountOptions}</div>`
              : `<div class="empty">Aucun compte agent : ajoutez-en un dans les parametres.</div>`}
            <label>
              <span>Modele</span>
              <input id="newChatModel" list="codexModelSuggestions" value="${escapeAttr(modelValue)}" placeholder="${escapeAttr(providerDefaultModel(provider))}" autocomplete="off" spellcheck="false" maxlength="160" ${account ? "" : "disabled"} />
            </label>
            <label>
              <span>Mode</span>
              <select id="newChatMode" ${account ? "" : "disabled"}>
                <option value="build" ${newChatMode === "build" ? "selected" : ""}>Construire</option>
                <option value="plan" ${newChatMode === "plan" ? "selected" : ""}>Planifier</option>
                <option value="ask" ${newChatMode === "ask" ? "selected" : ""}>Question</option>
              </select>
            </label>
          </section>
        </div>

        <footer class="modal-actions">
          <button class="tool-button" id="cancelNewChat">Annuler</button>
          <button class="tool-button primary" id="confirmNewChat" ${account && environmentPath ? "" : "disabled"}>
            <i data-lucide="plus"></i>
            <span>Ouvrir le chat</span>
          </button>
        </footer>
      </section>
    </div>
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
  const selectedEnvironment = userEnvironmentPath(newTerminalWorkspacePath);
  const environmentOptions = terminalEnvironmentGroups()
    .map((group) => {
      const selected =
        !!selectedEnvironment &&
        workspaceIdForPath(group.path) === workspaceIdForPath(selectedEnvironment);
      return `<button
        type="button"
        class="new-terminal-environment-option ${selected ? "selected" : ""}"
        data-new-terminal-environment-path="${escapeAttr(group.path)}"
        aria-pressed="${selected}"
        title="${escapeAttr(group.path)}"
      >
        <i data-lucide="folder${selected ? "-open" : ""}"></i>
        <span><strong>${escapeHtml(group.label)}</strong><small>${escapeHtml(group.path)}</small></span>
        <b>${group.sessions.length}</b>
      </button>`;
    })
    .join("");

  return `
    <div class="modal-backdrop" id="newTerminalBackdrop">
      <section class="modal" role="dialog" aria-modal="true" aria-labelledby="newTerminalTitle">
        <header class="modal-head">
          <div>
            <h2 id="newTerminalTitle">Nouvelle session terminal</h2>
            <p>L'environnement est obligatoire et reste verrouille pendant toute la session.</p>
          </div>
          <button class="icon-button" id="closeNewTerminalModal" title="Fermer">
            <i data-lucide="x"></i>
          </button>
        </header>

        <div class="modal-body">
          <section class="modal-section">
            <div class="new-terminal-environment-required ${selectedEnvironment ? "selected" : "missing"}">
              <span class="new-terminal-environment-required-icon"><i data-lucide="shield-check"></i></span>
              <span>
                <strong>1. Choisir l'environnement isole</strong>
                <small>${selectedEnvironment ? escapeHtml(selectedEnvironment) : "Aucun terminal ne peut demarrer sans environnement explicite"}</small>
              </span>
            </div>
            ${environmentOptions
              ? `<div class="new-terminal-environment-options" role="radiogroup" aria-label="Environnements recents">${environmentOptions}</div>`
              : ""}
            <label class="new-terminal-environment-field">
              <span>Environnement de ce terminal / session (obligatoire)</span>
              <div class="field-row">
                <input id="newTerminalWorkspace" value="${escapeAttr(selectedEnvironment ?? "")}" placeholder="${escapeAttr(isRemoteMode() ? "/chemin/vers/environnement" : "C:\\chemin\\vers\\environnement")}" spellcheck="false" required aria-required="true" aria-invalid="${!selectedEnvironment}" />
                <button id="pickNewTerminalWorkspace" type="button" class="icon-button" title="Choisir l'environnement">
                  <i data-lucide="folder-open"></i>
                </button>
              </div>
              <small class="new-terminal-environment-help">Les fichiers, le cwd, le worktree et le home de l'agent seront separes des autres onglets.</small>
            </label>
            <label>
              <span>2. Agent</span>
              <select id="newTerminalAgent" ${settings.agents.length > 0 ? "" : "disabled"}>
                ${agentOptions || `<option value="">Aucun agent</option>`}
              </select>
            </label>
            <label>
              <span>3. Compte</span>
              <select id="newTerminalAccount" ${settings.accounts.length > 0 ? "" : "disabled"}>
                ${accountOptions || `<option value="">Aucun compte</option>`}
              </select>
            </label>
            <div class="account-create-box">
              <strong>Ajouter un nouveau compte agent</strong>
              <div class="account-create-grid">
                <label>
                  <span>Nom du compte</span>
                  <input id="newTerminalAccountLabel" value="${escapeAttr(newTerminalAccountLabel)}" placeholder="perso, pro, client" />
                </label>
                <label>
                  <span>Fournisseur</span>
                  <select id="newAccountProvider">
                    <option value="codex" ${newTerminalAccountProvider === "codex" ? "selected" : ""}>Codex (ChatGPT)</option>
                    <option value="claude" ${newTerminalAccountProvider === "claude" ? "selected" : ""}>Claude Code</option>
                  </select>
                </label>
                <label>
                  <span>Modele par defaut</span>
                  <input id="newAccountModel" list="codexModelSuggestions" value="${escapeAttr(newTerminalAccountModel)}" placeholder="${DEFAULT_CODEX_MODEL} / sonnet" />
                </label>
                <label title="Intensite de raisonnement : Codex uniquement (ignoree pour Claude)">
                  <span>Intensite (Codex)</span>
                  <select id="newAccountReasoningEffort">${reasoningEffortOptions(newTerminalAccountReasoningEffort)}</select>
                </label>
                <label class="modal-check" title="Sans approbations / sans sandbox (Codex : bypass ; Claude : skip permissions)">
                  <input id="newAccountBypass" type="checkbox" ${newTerminalAccountBypass ? "checked" : ""} />
                  <span>Mode bypass</span>
                </label>
              </div>
              <button class="tool-button" id="addAccountFromModal">
                <i data-lucide="plus"></i><span>Ajouter ce compte</span>
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
            <label>
              <span>Modele Codex par defaut</span>
              <input id="newTerminalModel" list="codexModelSuggestions" value="${escapeAttr(accountModel(account))}" ${account ? "" : "disabled"} />
            </label>
            <label>
              <span>Intensite par defaut</span>
              <select id="newTerminalReasoningEffort" ${account ? "" : "disabled"}>${reasoningEffortOptions(accountReasoningEffort(account))}</select>
            </label>
            <label class="modal-check" title="Sans approbations et sans sandbox Codex">
              <input id="newTerminalBypass" type="checkbox" ${accountBypassEnabled(account) ? "checked" : ""} ${account ? "" : "disabled"} />
              <span>Mode bypass pour ce compte</span>
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
            ? `<button class="tool-button" id="loginNewTerminal" ${account && selectedEnvironment ? "" : "disabled"}>
            <i data-lucide="badge-check"></i>
            <span>Login ${escapeHtml(selectedAgent.label)}</span>
          </button>`
            : ""}
          <button class="tool-button primary" id="confirmNewTerminal" ${account && selectedEnvironment ? "" : "disabled"}>
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
          <p class="agent-hint">Kombai est une extension d'IDE : un agent <strong>IDE</strong> ouvre l'editeur choisi (code, cursor, windsurf, trae, antigravity, kiro) sur l'environnement projet, ou tu utilises le panneau Kombai.</p>
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
  const entries = (data?.entries ?? []).filter(
    (entry) => !isEphemeralChatWorkspacePath(entry.path),
  );
  const selectableBrowsePath = userEnvironmentPath(data?.path);
  const breadcrumbs = workspacePathBreadcrumbs(data?.root, data?.path);
  const breadcrumbTrail = breadcrumbs
    .map(
      (breadcrumb, index) => `
        <span class="ws-breadcrumb-part">
          ${index ? `<i data-lucide="chevron-right"></i>` : ""}
          <button type="button" data-ws-dir="${escapeAttr(breadcrumb.path)}" ${index === breadcrumbs.length - 1 ? 'aria-current="location"' : ""} title="${escapeAttr(breadcrumb.path)}">${escapeHtml(breadcrumb.label)}</button>
        </span>`,
    )
    .join("");
  const browseId = data?.path ? workspaceIdForPath(data.path) : null;
  const quickAccess = knownWorkspaces()
    .filter((workspace) => workspace.id !== browseId)
    .slice(0, 8)
    .map(
      (workspace) => `
        <button type="button" class="ws-quick-entry" data-ws-dir="${escapeAttr(workspace.path)}" title="${escapeAttr(workspace.path)}">
          <i data-lucide="folder"></i>
          <span><strong>${escapeHtml(workspace.label)}</strong><small>${escapeHtml(workspace.path)}</small></span>
        </button>`,
    )
    .join("");
  const list = entries
    .map(
      (entry) => `
        <button type="button" class="ws-entry ws-folder-entry" data-ws-dir="${escapeAttr(entry.path)}" data-ws-name="${escapeAttr(entry.name.toLocaleLowerCase())}" title="Ouvrir ${escapeAttr(entry.path)}">
          <i data-lucide="folder-open"></i>
          <span class="ws-entry-copy"><strong>${escapeHtml(entry.name)}</strong><small>${escapeHtml(entry.path)}</small></span>
          <i data-lucide="chevron-right"></i>
        </button>`,
    )
    .join("");
  const selected = workspacePickerPath();
  const pickingForTerminal = workspacePickerTarget === "new-terminal";

  return `
    <div class="modal-backdrop" id="workspaceBackdrop">
      <section class="modal workspace-browser-modal" role="dialog" aria-modal="true" aria-labelledby="workspaceModalTitle">
        <header class="modal-head">
          <div>
            <h2 id="workspaceModalTitle">${pickingForTerminal ? "Environnement du nouveau terminal" : "Choisir l'environnement actif"}</h2>
            <p>${pickingForTerminal ? "Naviguez puis choisissez le dossier fixe de cette session." : "Parcourez les dossiers puis choisissez celui qui regroupera les chats et les agents."}</p>
          </div>
          <button class="icon-button" id="closeWorkspaceModal" title="Fermer">
            <i data-lucide="x"></i>
          </button>
        </header>

        <div class="modal-body workspace-browser-body">
          ${breadcrumbTrail ? `<nav class="ws-breadcrumb" aria-label="Chemin du dossier">${breadcrumbTrail}</nav>` : ""}
          <div class="ws-path-row">
            <input id="workspacePathInput" value="${escapeAttr(data?.path ?? "")}" placeholder="Chemin du dossier" spellcheck="false" aria-label="Chemin du dossier" />
            <button class="tool-button" id="workspaceGo" title="Aller a ce chemin">
              <i data-lucide="search"></i>
              <span>Aller</span>
            </button>
          </div>
          ${selected ? `<div class="ws-current">Environnement actif : <strong>${escapeHtml(selected)}</strong></div>` : ""}
          ${quickAccess ? `<section class="ws-quick-access"><header><span>Acces rapides</span><small>Environnements connus</small></header><div>${quickAccess}</div></section>` : ""}
          <div class="ws-folder-toolbar">
            <label for="workspaceFolderSearch"><i data-lucide="search"></i><input id="workspaceFolderSearch" type="search" placeholder="Filtrer les sous-dossiers..." autocomplete="off" /></label>
            <span id="workspaceVisibleFolderCount">${entries.length} dossier${entries.length > 1 ? "s" : ""}</span>
          </div>
          ${data?.parent
            ? `<button class="ws-entry ws-parent" data-ws-dir="${escapeAttr(data.parent)}" title="${escapeAttr(data.parent)}">
                 <i data-lucide="arrow-left"></i>
                 <span class="ws-entry-copy"><strong>Dossier parent</strong><small>${escapeHtml(data.parent)}</small></span>
               </button>`
            : ""}
          ${workspaceBrowseLoading ? `<div class="ws-hint">Chargement...</div>` : ""}
          ${workspaceBrowseError ? `<div class="ws-error">${escapeHtml(workspaceBrowseError)}</div>` : ""}
          ${data?.path && !selectableBrowsePath ? `<div class="ws-error">Ce dossier appartient au runtime temporaire des agents. Il ne peut pas devenir un environnement.</div>` : ""}
          <div class="ws-list">${list || (workspaceBrowseLoading ? "" : `<div class="empty">Aucun sous-dossier</div>`)}</div>
          <div class="empty ws-search-empty" id="workspaceSearchEmpty" hidden>Aucun dossier ne correspond a la recherche.</div>
        </div>

        <footer class="modal-actions">
          <button class="tool-button" id="cancelWorkspaceModal">Annuler</button>
          ${pickingForTerminal ? "" : `<button class="tool-button" id="clearWorkspaceModal">Fermer l'environnement</button>`}
          <button class="tool-button primary" id="confirmWorkspaceModal" ${selectableBrowsePath ? "" : "disabled"}>
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
            <span>${escapeHtml(`${status.url} | ${projectDir ?? "aucun environnement"}`)}</span>
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
        <div><span>Environnement projet</span><strong>${escapeHtml(projectDir ?? "aucun (compte sans projet)")}</strong></div>
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
          <label>
            <span>Modele Codex par defaut</span>
            <input id="poolNewAccountModel" list="codexModelSuggestions" value="${escapeAttr(poolNewAccountModel)}" placeholder="${DEFAULT_CODEX_MODEL}" />
          </label>
          <label>
            <span>Intensite par defaut</span>
            <select id="poolNewAccountReasoningEffort">${reasoningEffortOptions(poolNewAccountReasoningEffort)}</select>
          </label>
          <label class="pool-check" title="Sans approbations et sans sandbox Codex">
            <input id="poolNewAccountBypass" type="checkbox" ${poolNewAccountBypass ? "checked" : ""} />
            <span>Mode bypass</span>
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
  const availableCount = limitStatus.filter(
    (account) => account.source === "server" || account.source === "session",
  ).length;

  return `
    <section class="limits-panel">
      <div class="limits-head">
        <div>
          <strong>Limites comptes</strong>
          <span>${connected}/${settings?.accounts.length ?? 0} comptes connectes · ${availableCount} limites disponibles</span>
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
      <button type="button" class="tool-button limit-relogin${limitNeedsRelogin(account) ? " primary" : ""}" data-relogin-account="${escapeAttr(account.id)}" title="Ouvrir un terminal de connexion (codex login) pour ce compte">
        <i data-lucide="log-in"></i><span>${escapeHtml(limitReloginLabel(account))}</span>
      </button>
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
  if (account.source === "server" || account.source === "session") return "connected";
  if (account.source === "server-empty") return "empty";
  return "error";
};

const limitSourceLabel = (account: AccountLimitView) => {
  if (!account.hasTokens) return "non connecte";
  if (account.source === "server") return "serveur";
  if (account.source === "session") return "session Codex";
  if (account.source === "server-empty") return "vide";
  return "erreur";
};

// Un token revoque/invalide (`token_invalidated`, `refresh_token_invalidated`,
// 401...) laisse un compte « connecte » cote fichier mais illisible cote serveur.
const AUTH_LIMIT_ERROR =
  /token[_ ]?invalidat|refresh[_ ]?token|revoked|revoqu|\b401\b|unauthor|authentication|session (?:has )?ended|sign(?:ing)? ?in again|log ?in again|not logged in|connexion requise|authentication required/i;

// Vrai quand le compte doit etre (re)connecte pour que ses quotas redeviennent
// lisibles : jamais connecte, ou lecture serveur echouee sur une erreur d'auth.
const limitNeedsRelogin = (account: AccountLimitView): boolean => {
  if (!account.hasTokens || account.source === "none") return true;
  if (account.source === "unavailable") {
    return !account.error || AUTH_LIMIT_ERROR.test(account.error);
  }
  return false;
};

const limitReloginLabel = (account: AccountLimitView): string =>
  account.hasTokens && account.source !== "none" ? "Reconnecter" : "Connecter";

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

const defaultCodexHomeForLabel = (label: string, provider: Provider = "codex") => {
  const slug =
    label
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "") || "account";
  if (isRemoteMode()) {
    return `${userHomeHint()}/${provider === "claude" ? "claude-" : ""}${slug}`;
  }
  // Home isole par compte : `.codex-<slug>` (CODEX_HOME) ou `.claude-<slug>`
  // (CLAUDE_CONFIG_DIR).
  const prefix = provider === "claude" ? ".claude-" : ".codex-";
  return `${userHomeHint()}\\${prefix}${slug}`;
};

const normalizeCodexHome = (value: string) => value.trim().replaceAll("/", "\\").toLowerCase();

const uniqueCodexHomeForLabel = (label: string, provider: Provider = "codex") => {
  const used = new Set((settings?.accounts ?? []).map((account) => normalizeCodexHome(account.codexHome)));
  let candidate = defaultCodexHomeForLabel(label, provider);
  if (!used.has(normalizeCodexHome(candidate))) return candidate;

  for (let index = 2; index < 1000; index += 1) {
    candidate = defaultCodexHomeForLabel(`${label}-${index}`, provider);
    if (!used.has(normalizeCodexHome(candidate))) return candidate;
  }

  return defaultCodexHomeForLabel(`${label}-${Date.now().toString(36)}`, provider);
};

type NewAccountPreferences = {
  provider?: Provider;
  bypass?: boolean;
  model?: string | null;
  reasoningEffort?: string | null;
};

const newAccountProfile = (
  label: string,
  codexHome: string | undefined = undefined,
  projectDir: string | null = null,
  proxyId: string | null = null,
  preferences: NewAccountPreferences = {},
): AccountProfile => {
  const provider = preferences.provider ?? "codex";
  return {
    id: uid("account"),
    label,
    provider,
    codexHome: codexHome ?? defaultCodexHomeForLabel(label, provider),
    projectDir,
    proxyId,
    startupCommand: null,
    bypass: preferences.bypass ?? settings?.codexBypass ?? true,
    model: preferences.model?.trim() || providerDefaultModel(provider),
    // L'intensite de raisonnement ne concerne que Codex ; on la laisse par
    // defaut pour Claude (le backend l'ignore).
    reasoningEffort: normalizeCodexReasoningEffort(preferences.reasoningEffort),
  };
};

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
  poolNewAccountBypass =
    document.querySelector<HTMLInputElement>("#poolNewAccountBypass")?.checked ?? poolNewAccountBypass;
  poolNewAccountModel =
    document.querySelector<HTMLInputElement>("#poolNewAccountModel")?.value.trim() ||
    poolNewAccountModel ||
    DEFAULT_CODEX_MODEL;
  poolNewAccountReasoningEffort = normalizeCodexReasoningEffort(
    document.querySelector<HTMLSelectElement>("#poolNewAccountReasoningEffort")?.value ??
      poolNewAccountReasoningEffort,
  );
};

const clearPoolNewAccountForm = () => {
  poolNewAccountLabel = "";
  poolNewAccountProxyId = "";
  poolNewAccountBypass = settings?.codexBypass ?? true;
  poolNewAccountModel = DEFAULT_CODEX_MODEL;
  poolNewAccountReasoningEffort = DEFAULT_CODEX_REASONING_EFFORT;
};

const addPoolAccount = async () => {
  if (!settings) return;
  readPoolForm();
  readPoolNewAccountForm();

  const label = poolNewAccountLabel || "Nouveau compte";
  const codexHome = uniqueCodexHomeForLabel(label);
  const proxyId = settings.proxyControlsEnabled ? poolNewAccountProxyId || null : null;

  try {
    const account = newAccountProfile(label, codexHome, null, proxyId, {
      bypass: poolNewAccountBypass,
      model: poolNewAccountModel,
      reasoningEffort: poolNewAccountReasoningEffort,
    });
    // Provisionne les permissions des la creation. Sans cela, le compte etait
    // marque bypass dans settings.json mais son config.toml ne l'etait qu'au
    // premier lancement d'un terminal.
    await provisionAccountHome(account);
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

const openNewChatModal = (options: { workspacePath?: string | null } = {}) => {
  if (!settings) return;
  const environmentPath = userEnvironmentPath(options.workspacePath ?? currentWorkspace());
  if (!environmentPath) {
    // Pas d'environnement isole : on conserve le garde-fou existant.
    openTerminalEnvironmentMenu();
    return;
  }
  newChatPendingWorkspace = environmentPath;
  newChatAccountId =
    selectedAccountId ?? settings.defaultAccountId ?? settings.accounts[0]?.id ?? null;
  newChatModel = accountModel(accountById(newChatAccountId));
  newChatMode = "build";
  newChatModalOpen = true;
  statusText = "Choisis le compte, le modele et le mode de ce chat";
  render();
  window.setTimeout(() => {
    document.querySelector<HTMLInputElement>("#newChatModel")?.focus();
  }, 0);
};

const closeNewChatModal = () => {
  if (!newChatModalOpen) return;
  newChatModalOpen = false;
  render();
};

const confirmNewChatModal = () => {
  if (!settings) return;
  const account = accountById(newChatAccountId) ?? settings.accounts[0] ?? null;
  if (!account) {
    statusText = "Ajoute d'abord un compte agent";
    render();
    return;
  }
  const modelInput = document.querySelector<HTMLInputElement>("#newChatModel");
  const modeSelect = document.querySelector<HTMLSelectElement>("#newChatMode");
  const requestedModel = (modelInput?.value ?? newChatModel).trim();
  if (requestedModel.length > 160 || /\s/.test(requestedModel)) {
    modelInput?.setCustomValidity(
      "Le nom du modele doit faire 160 caracteres maximum et ne contenir aucun espace",
    );
    modelInput?.reportValidity();
    statusText = "Nom de modele invalide";
    return;
  }
  const mode = (modeSelect?.value as ChatMode) || newChatMode;
  const previousModel = accountModel(account);
  const nextModel = requestedModel || previousModel;
  if (nextModel !== previousModel) {
    account.model = nextModel;
    persistChatPreferences(account.id);
  }
  selectedAccountId = account.id;
  const pendingWorkspace = newChatPendingWorkspace;
  newChatModalOpen = false;
  addExpertChatPane(account.id, { mode, pendingWorkspace });
  void loadChatModelCatalog(account.id);
};

const openNewTerminalModal = (folderPath: string | null | undefined = undefined) => {
  if (!settings) return;
  if (terminalSessions.length >= EXPERT_MAX_TERMINALS) {
    statusText = `Limite atteinte: ${EXPERT_MAX_TERMINALS} terminaux maximum dans une fenetre`;
    render();
    return;
  }
  newTerminalAccountId = selectedAccountId || settings.defaultAccountId || settings.accounts[0]?.id || null;
  newTerminalAgentId = settings.activeAgentId || settings.agents[0]?.id || null;
  newTerminalWorkspacePath =
    folderPath === undefined ? null : userEnvironmentPath(folderPath);
  newTerminalAccountLabel = "";
  newTerminalAccountBypass = settings.codexBypass ?? true;
  newTerminalAccountModel = DEFAULT_CODEX_MODEL;
  newTerminalAccountReasoningEffort = DEFAULT_CODEX_REASONING_EFFORT;
  newTerminalModalOpen = true;
  statusText = "Choisis obligatoirement l'environnement, puis l'agent et le compte";
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

  newTerminalWorkspacePath =
    document.querySelector<HTMLInputElement>("#newTerminalWorkspace")?.value.trim() || null;

  account.codexHome =
    document.querySelector<HTMLInputElement>("#newTerminalCodexHome")?.value.trim() ||
    account.codexHome ||
    defaultCodexHomeForLabel(account.label);
  account.projectDir =
    document.querySelector<HTMLInputElement>("#newTerminalProjectDir")?.value.trim() || null;
  if (settings.proxyControlsEnabled) {
    account.proxyId = document.querySelector<HTMLSelectElement>("#newTerminalProxy")?.value || null;
  }
  account.model =
    document.querySelector<HTMLInputElement>("#newTerminalModel")?.value.trim() ||
    accountModel(account);
  account.reasoningEffort = normalizeCodexReasoningEffort(
    document.querySelector<HTMLSelectElement>("#newTerminalReasoningEffort")?.value ??
      account.reasoningEffort,
  );
  account.bypass =
    document.querySelector<HTMLInputElement>("#newTerminalBypass")?.checked ??
    accountBypassEnabled(account);
  const agentSelect = document.querySelector<HTMLSelectElement>("#newTerminalAgent");
  if (agentSelect) newTerminalAgentId = agentSelect.value || newTerminalAgentId;
  settings.autoRunCodex = document.querySelector<HTMLInputElement>("#newTerminalAutoRun")?.checked ?? settings.autoRunCodex;
  return account;
};

const readNewTerminalAccountDraft = () => {
  newTerminalAccountLabel =
    document.querySelector<HTMLInputElement>("#newTerminalAccountLabel")?.value.trim() ??
    newTerminalAccountLabel;
  const providerValue = document.querySelector<HTMLSelectElement>("#newAccountProvider")?.value;
  newTerminalAccountProvider = providerValue === "claude" ? "claude" : "codex";
  newTerminalAccountBypass =
    document.querySelector<HTMLInputElement>("#newAccountBypass")?.checked ??
    newTerminalAccountBypass;
  newTerminalAccountModel =
    document.querySelector<HTMLInputElement>("#newAccountModel")?.value.trim() ||
    newTerminalAccountModel ||
    DEFAULT_CODEX_MODEL;
  newTerminalAccountReasoningEffort = normalizeCodexReasoningEffort(
    document.querySelector<HTMLSelectElement>("#newAccountReasoningEffort")?.value ??
      newTerminalAccountReasoningEffort,
  );
};

const addAccountFromModal = () => {
  if (!settings) return;
  readNewTerminalAccountDraft();
  const label = newTerminalAccountLabel;
  if (!label) {
    statusText = "Nom de compte manquant";
    render();
    return;
  }

  // Si l'utilisateur passe en Claude sans toucher au champ modele (encore sur le
  // defaut Codex), on laisse le defaut Claude s'appliquer plutot que d'heriter
  // d'un modele Codex incoherent.
  const model =
    newTerminalAccountProvider === "claude" && newTerminalAccountModel === DEFAULT_CODEX_MODEL
      ? null
      : newTerminalAccountModel;
  const account = newAccountProfile(label, undefined, null, null, {
    provider: newTerminalAccountProvider,
    bypass: newTerminalAccountBypass,
    model,
    reasoningEffort: newTerminalAccountReasoningEffort,
  });
  settings.accounts.push(account);
  selectedAccountId = account.id;
  newTerminalAccountId = account.id;
  newTerminalAccountLabel = "";
  const providerNote = providerLabel(accountProvider(account));
  const loginHint =
    account.provider === "claude" ? " — lance-le puis tape /login pour t'authentifier" : "";
  statusText = `Compte ${providerNote} ajoute (${account.bypass ? "bypass" : "sandbox"}, ${account.model})${loginHint}`;
  render();
};

// « + Compte » depuis l'editeur : cree un compte (CODEX_HOME unique), le
// persiste tout de suite pour qu'il soit reellement supprimable, puis ouvre une
// fenetre de connexion interactive (codex login / claude) afin de s'authentifier
// sans etape supplementaire. On capture d'abord les modifs en cours de l'ancien
// compte selectionne pour ne pas les perdre.
const addAccountAndLogin = async () => {
  if (!settings) return;
  readSettingsForm();
  const label = "Nouveau compte";
  const account = newAccountProfile(label, uniqueCodexHomeForLabel(label));
  settings.accounts.push(account);
  selectedAccountId = account.id;
  settings.defaultAccountId = account.id;
  try {
    settings = await invoke<AppSettings>("save_settings", { settings });
  } catch (error) {
    statusText = String(error);
    render();
    return;
  }
  render();
  // Ouvre le terminal de login. Necessite un environnement : sans lui,
  // reloginAccount affiche le message d'aide adequat (le compte reste cree).
  await reloginAccount(account.id);
};

// Suppression depuis l'editeur : suppression backend d'abord (compte persiste),
// avec repli en memoire + save_settings pour un compte tout juste cree que le
// backend ne connait pas encore (« Compte introuvable »). Par defaut on ne
// touche pas au CODEX_HOME ; si l'auto-detection est active on propose de l'effacer
// aussi, sans quoi le compte serait re-decouvert et reapparaitrait.
const deleteSelectedAccount = async () => {
  if (!settings || !selectedAccountId) return;
  const id = selectedAccountId;
  const target = settings.accounts.find((account) => account.id === id);
  const label = target?.label ?? "";

  // Avec l'auto-detection active, un compte dont le CODEX_HOME existe encore est
  // re-decouvert au prochain chargement et "revient" : suppression sans effet
  // ressenti. On propose alors d'effacer aussi le dossier pour que ce soit
  // definitif (sinon on previent que le compte peut reapparaitre).
  let deleteFiles = false;
  if (settings.autoDiscoverAccounts && target) {
    deleteFiles = window.confirm(
      `L'auto-détection des comptes est active.\n\n` +
        `Pour supprimer DÉFINITIVEMENT « ${label} », il faut aussi effacer son dossier :\n${target.codexHome}\n\n` +
        `• OK : supprimer le compte ET ses fichiers (auth, sessions, config…).\n` +
        `• Annuler : garder les fichiers — le compte réapparaîtra au prochain scan.`,
    );
  }

  try {
    settings = await invoke<AppSettings>("remove_account", { accountId: id, deleteFiles });
    statusText = deleteFiles
      ? `Compte « ${label} » supprime (fichiers effaces)`
      : `Compte « ${label} » supprime`;
  } catch {
    settings.accounts = settings.accounts.filter((account) => account.id !== id);
    if (settings.defaultAccountId === id) {
      settings.defaultAccountId = settings.accounts[0]?.id ?? null;
    }
    try {
      settings = await invoke<AppSettings>("save_settings", { settings });
      statusText = `Compte « ${label} » retire`;
    } catch (error) {
      statusText = String(error);
      render();
      return;
    }
  }
  selectedAccountId = settings.defaultAccountId ?? settings.accounts[0]?.id ?? null;
  render();
};

const bindUi = () => {
  bindChatSidebarResizer();

  document
    .querySelectorAll<HTMLButtonElement>("#chooseTerminalEnvironment, #chooseEnvironmentFromChat")
    .forEach((button) => {
      button.addEventListener("click", openTerminalEnvironmentMenu);
    });

  document.querySelectorAll<HTMLButtonElement>("[data-environment-menu-id]").forEach((button) => {
    button.addEventListener("click", () => {
      const id = button.dataset.environmentMenuId;
      const group = terminalEnvironmentGroups().find(
        (candidate) => id && workspaceIdForPath(candidate.path) === id,
      );
      if (!group) return;
      void selectEnvironment(group.path);
    });
  });
  document.querySelectorAll<HTMLButtonElement>("[data-delete-environment-id]").forEach((button) => {
    button.addEventListener("click", () => {
      const id = button.dataset.deleteEnvironmentId;
      const workspace = knownWorkspaces().find((candidate) => candidate.id === id);
      if (!workspace) return;
      const confirmed = window.confirm(
        `Supprimer l'environnement « ${workspace.label} » de Switch ?\n\nLe repertoire et ses fichiers resteront sur le disque.`,
      );
      if (confirmed) void closeWorkspace(workspace, true);
    });
  });
  document
    .querySelector<HTMLButtonElement>("#closeTerminalEnvironmentMenu")
    ?.addEventListener("click", closeTerminalEnvironmentMenu);
  document
    .querySelector<HTMLButtonElement>("#createEnvironmentFromMenu")
    ?.addEventListener("click", () => {
      terminalEnvironmentMenuOpen = false;
      render();
      void openWorkspacePicker("active");
    });
  document
    .querySelector<HTMLDivElement>("#terminalEnvironmentMenuBackdrop")
    ?.addEventListener("click", (event) => {
      if (event.target === event.currentTarget) closeTerminalEnvironmentMenu();
    });

  document.querySelector<HTMLSelectElement>("#expertGridLayout")?.addEventListener("change", (event) => {
    const value = (event.currentTarget as HTMLSelectElement).value;
    expertGridLayout = value === "2" || value === "3" || value === "4" ? value : "auto";
    localStorage.setItem(EXPERT_GRID_LAYOUT_STORAGE_KEY, expertGridLayout);
    statusText = expertGridLayout === "auto" ? "Disposition automatique" : `${expertGridLayout} colonnes`;
    render();
  });

  document.querySelector<HTMLSelectElement>("#expertChatPageSize")?.addEventListener("change", (event) => {
    captureAllExpertChatScroll();
    expertChatsPerPage = normalizeExpertChatPageSize(
      (event.currentTarget as HTMLSelectElement).value,
    );
    localStorage.setItem(EXPERT_CHATS_PER_PAGE_STORAGE_KEY, String(expertChatsPerPage));
    reconcileExpertChatPage();
    statusText = `${expertChatsPerPage} chats par page · ${expertChatStatusText()}`;
    persistExpertChats();
    render();
  });

  document.querySelector<HTMLButtonElement>("#expertChatPrevPage")?.addEventListener("click", () => {
    setExpertChatPage(expertChatPage - 1);
  });
  document.querySelector<HTMLButtonElement>("#expertChatNextPage")?.addEventListener("click", () => {
    setExpertChatPage(expertChatPage + 1);
  });

  document.querySelector<HTMLButtonElement>("#addExpertChat")?.addEventListener("click", () => {
    openNewChatModal();
  });
  document.querySelector<HTMLButtonElement>("#openEnvironmentCollaboration")?.addEventListener("click", () => {
    setActiveView("room");
  });

  document.querySelectorAll<HTMLButtonElement>("[data-add-expert-terminal]").forEach((button) => {
    button.addEventListener("click", () => openNewTerminalModal(terminalFolderFilter ?? undefined));
  });
  document.querySelector<HTMLButtonElement>("#folderNewTerminal")?.addEventListener("click", () => {
    openNewTerminalModal(terminalFolderFilter ?? undefined);
  });
  document.querySelector<HTMLButtonElement>("#folderNewChat")?.addEventListener("click", () => {
    if (terminalFolderFilter) {
      setCurrentWorkspace(terminalFolderFilter);
      setChatWorkspaceFilter(workspaceIdForPath(terminalFolderFilter));
    }
    openNewChat();
  });
  const focusExpertSession = (session: TerminalSession, focus = false) => {
    activateTerminalSession(session);
    statusText = `Terminal actif: ${terminalTitle(session)}`;
    document.querySelectorAll<HTMLElement>("[data-expert-terminal-pane]").forEach((pane) => {
      pane.classList.toggle("active", pane.dataset.expertTerminalPane === session.key);
    });
    document.querySelectorAll<HTMLElement>(".terminal-side-item").forEach((item) => {
      const key = item.querySelector<HTMLElement>("[data-terminal-key]")?.dataset.terminalKey;
      item.classList.toggle("active", key === session.key);
    });
    const title = document.querySelector<HTMLElement>("#expertActiveTitle");
    const meta = document.querySelector<HTMLElement>("#expertActiveMeta");
    if (title) title.textContent = terminalTitle(session);
    if (meta) {
      meta.textContent = `${session.proxySummary} | ${displayProjectDir(session.workspacePath ?? session.folderPath ?? session.projectDir)}`;
    }
    persistTerminalSessions();
    if (focus) session.terminal.focus();
  };

  document.querySelectorAll<HTMLButtonElement>("[data-focus-terminal]").forEach((button) => {
    button.addEventListener("click", () => {
      const session = terminalSessions.find((candidate) => candidate.key === button.dataset.focusTerminal);
      if (session) focusExpertSession(session, true);
    });
  });

  document.querySelectorAll<HTMLElement>("[data-expert-terminal-pane]").forEach((pane) => {
    pane.addEventListener("pointerdown", (event) => {
      if ((event.target as HTMLElement).closest("[data-close-terminal],[data-toggle-chat-sidebar],[data-toggle-terminal-fullscreen]")) return;
      const session = terminalSessions.find(
        (candidate) => candidate.key === pane.dataset.expertTerminalPane,
      );
      if (session && session.key !== activeTerminalKey) focusExpertSession(session);
    });

  });

  document.querySelectorAll<HTMLButtonElement>("[data-toggle-terminal-fullscreen]").forEach((button) => {
    button.addEventListener("click", () => {
      const session = terminalSessions.find(
        (candidate) => candidate.key === button.dataset.toggleTerminalFullscreen,
      );
      if (session) toggleExpertTerminalFullscreen(session);
    });
  });

  document.querySelectorAll<HTMLButtonElement>("[data-account]").forEach((button) => {
    button.addEventListener("click", () => {
      selectedAccountId = button.dataset.account ?? null;
      statusText = "Compte selectionne";
      render();
    });
  });

  document.querySelectorAll<HTMLButtonElement>("[data-terminal-key]").forEach((button) => {
    button.addEventListener("click", () => {
      const session = terminalSessions.find(
        (candidate) => candidate.key === button.dataset.terminalKey,
      );
      if (!session) return;
      activateTerminalSession(session);
      requestTerminalFocusKey = session.key;
      activeView = "terminal";
      stopLimitPoll();
      stopUsagePoll();
      stopKombaiPoll();
      stopDiscussionsPoll();
      stopRoomPoll();
      stopChatSync();
      statusText = "Terminal selectionne";
      render();
      persistTerminalSessions();
    });
  });

  document.querySelectorAll<HTMLButtonElement>("[data-workspace-key]").forEach((button) => {
    button.addEventListener("click", () => {
      const group = terminalWorkspaceGroups().find(
        (candidate) => candidate.key === button.dataset.workspaceKey,
      );
      if (!group) return;
      const session =
        group.sessions.find((candidate) => candidate.key === activeTerminalKey) ?? group.sessions[0];
      if (session) {
        activateTerminalSession(session);
      } else {
        activeTerminalKey = null;
      }
      setCurrentWorkspace(group.path);
      terminalFolderFilter = group.path;
      if (group.path) void upsertWorkspaceRegistry(group.path);
      activeView = "terminal";
      stopLimitPoll();
      stopUsagePoll();
      stopKombaiPoll();
      stopDiscussionsPoll();
      stopRoomPoll();
      stopChatSync();
      statusText = `Environnement actif: ${group.label}`;
      render();
      persistTerminalSessions();
    });
  });

  document
    .querySelectorAll<HTMLButtonElement>("[data-new-terminal-workspace]")
    .forEach((button) => {
      button.addEventListener("click", () => {
        const group = terminalWorkspaceGroups().find(
          (candidate) => candidate.key === button.dataset.newTerminalWorkspace,
        );
        if (!group) return;
        setCurrentWorkspace(group.path);
        terminalFolderFilter = group.path;
        if (group.path) void upsertWorkspaceRegistry(group.path);
        openNewTerminalModal(group.path);
      });
    });

  document.querySelectorAll<HTMLButtonElement>("[data-close-terminal]").forEach((button) => {
    button.addEventListener("click", () => {
      const key = button.dataset.closeTerminal;
      if (key) void closeTerminalSession(key);
    });
  });

  document.querySelectorAll<HTMLButtonElement>("[data-toggle-chat-sidebar]").forEach((button) => {
    button.addEventListener("click", () => {
      if (displayedChatSidebarWidth() === 0) {
        setChatSidebarWidth(defaultChatSidebarWidth(window.innerWidth));
      } else {
        setChatSidebarWidth(0);
      }
      fitAndResizeVisibleTerminals();
    });
  });

  document.querySelector<HTMLButtonElement>("#addAccount")?.addEventListener("click", () => {
    void addAccountAndLogin();
  });

  document.querySelector<HTMLButtonElement>("#loginAccount")?.addEventListener("click", () => {
    if (!selectedAccountId) return;
    // Capture les modifs en cours (CODEX_HOME, label…) avant d'ouvrir le login,
    // sinon la connexion utiliserait l'ancien home du compte.
    readSettingsForm();
    void reloginAccount(selectedAccountId);
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
    void openWorkspacePicker("active");
  });

  document.querySelector<HTMLButtonElement>("#workspaceAddSide")?.addEventListener("click", () => {
    void openWorkspacePicker("active");
  });

  // Switcher de workspace (barre laterale du chat) : selection d'un dossier /
  // filtre, ou ouverture d'un nouveau dossier.
  bindWorkspaceSwitcherUi();

  document.querySelector<HTMLButtonElement>("#workspaceClear")?.addEventListener("click", () => {
    const path = currentWorkspace();
    const workspace = path
      ? knownWorkspaces().find((candidate) => candidate.id === workspaceIdForPath(path))
      : null;
    if (workspace) void closeWorkspace(workspace);
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

  document.querySelector<HTMLInputElement>("#workspaceFolderSearch")?.addEventListener("input", (event) => {
    const query = (event.currentTarget as HTMLInputElement).value.trim().toLocaleLowerCase();
    let visible = 0;
    document.querySelectorAll<HTMLButtonElement>(".ws-folder-entry").forEach((entry) => {
      const matches = !query || (entry.dataset.wsName ?? "").includes(query);
      entry.hidden = !matches;
      if (matches) visible += 1;
    });
    const count = document.querySelector<HTMLElement>("#workspaceVisibleFolderCount");
    if (count) count.textContent = `${visible} dossier${visible > 1 ? "s" : ""}`;
    const empty = document.querySelector<HTMLElement>("#workspaceSearchEmpty");
    if (empty) empty.hidden = !query || visible > 0;
  });

  document.querySelector<HTMLButtonElement>("#confirmWorkspaceModal")?.addEventListener("click", () => {
    const path = workspaceBrowse?.path?.trim();
    if (path) chooseWorkspace(path);
  });

  document.querySelector<HTMLButtonElement>("#clearWorkspaceModal")?.addEventListener("click", () => {
    chooseWorkspace(null, workspacePickerTarget);
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

  document.querySelector<HTMLButtonElement>("#expertTerminalAction")?.addEventListener("click", () => {
    if (activeView !== "terminal") {
      setActiveView("terminal");
      return;
    }
    openNewTerminalModal();
  });

  document.querySelector<HTMLButtonElement>("#newTerminalSide")?.addEventListener("click", () => {
    openNewTerminalModal();
  });

  document.querySelector<HTMLButtonElement>("#pickNewTerminalWorkspace")?.addEventListener("click", () => {
    readNewTerminalAccountDraft();
    readNewTerminalModalForm();
    void openWorkspacePicker("new-terminal");
  });

  document
    .querySelectorAll<HTMLButtonElement>("[data-new-terminal-environment-path]")
    .forEach((button) => {
      button.addEventListener("click", () => {
        readNewTerminalAccountDraft();
        readNewTerminalModalForm();
        newTerminalWorkspacePath = userEnvironmentPath(
          button.dataset.newTerminalEnvironmentPath,
        );
        if (newTerminalWorkspacePath) rememberWorkspace(newTerminalWorkspacePath);
        statusText = `Environnement selectionne: ${newTerminalWorkspacePath}`;
        render();
      });
    });

  document.querySelector<HTMLInputElement>("#newTerminalWorkspace")?.addEventListener("input", (event) => {
    const input = event.currentTarget as HTMLInputElement;
    newTerminalWorkspacePath = userEnvironmentPath(input.value);
    const hasEnvironment = !!newTerminalWorkspacePath;
    input.setAttribute("aria-invalid", String(!hasEnvironment));
    document
      .querySelector<HTMLElement>(".new-terminal-environment-required")
      ?.classList.toggle("missing", !hasEnvironment);
    document
      .querySelector<HTMLElement>(".new-terminal-environment-required")
      ?.classList.toggle("selected", hasEnvironment);
    const accountAvailable = !!newTerminalAccount();
    const confirm = document.querySelector<HTMLButtonElement>("#confirmNewTerminal");
    const login = document.querySelector<HTMLButtonElement>("#loginNewTerminal");
    if (confirm) confirm.disabled = !accountAvailable || !hasEnvironment;
    if (login) login.disabled = !accountAvailable || !hasEnvironment;
  });

  document.querySelector<HTMLButtonElement>("#closeNewChatModal")?.addEventListener("click", () => {
    closeNewChatModal();
  });
  document.querySelector<HTMLButtonElement>("#cancelNewChat")?.addEventListener("click", () => {
    closeNewChatModal();
  });
  document.querySelector<HTMLDivElement>("#newChatBackdrop")?.addEventListener("click", (event) => {
    if (event.target === event.currentTarget) closeNewChatModal();
  });
  document.querySelectorAll<HTMLButtonElement>("[data-new-chat-account]").forEach((button) => {
    button.addEventListener("click", () => {
      // Conserve le mode saisi puis reinitialise le modele au defaut du compte choisi.
      const modeSelect = document.querySelector<HTMLSelectElement>("#newChatMode");
      if (modeSelect) newChatMode = (modeSelect.value as ChatMode) || newChatMode;
      newChatAccountId = button.dataset.newChatAccount || null;
      newChatModel = accountModel(accountById(newChatAccountId));
      render();
      window.setTimeout(() => {
        document.querySelector<HTMLInputElement>("#newChatModel")?.focus();
      }, 0);
    });
  });
  const newChatModelInput = document.querySelector<HTMLInputElement>("#newChatModel");
  newChatModelInput?.addEventListener("input", () => {
    newChatModelInput.setCustomValidity("");
    newChatModel = newChatModelInput.value;
  });
  document.querySelector<HTMLSelectElement>("#newChatMode")?.addEventListener("change", (event) => {
    newChatMode = (event.currentTarget as HTMLSelectElement).value as ChatMode;
  });
  document.querySelector<HTMLButtonElement>("#confirmNewChat")?.addEventListener("click", () => {
    confirmNewChatModal();
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
    readNewTerminalAccountDraft();
    readNewTerminalModalForm();
    newTerminalAccountId = (event.currentTarget as HTMLSelectElement).value || null;
    render();
  });

  document.querySelector<HTMLSelectElement>("#newTerminalAgent")?.addEventListener("change", (event) => {
    // Committe les champs saisis (CODEX_HOME, projet, proxy) avant le re-render,
    // sinon changer d'agent (qui ne change pas de compte) les remettrait a zero.
    readNewTerminalAccountDraft();
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
    const environmentPath = userEnvironmentPath(newTerminalWorkspacePath);
    if (!environmentPath) {
      statusText = "Choisis un environnement avant de creer le terminal";
      render();
      return;
    }
    newTerminalWorkspacePath = environmentPath;
    setCurrentWorkspace(environmentPath);
    terminalFolderFilter = environmentPath;
    void upsertWorkspaceRegistry(environmentPath);
    newTerminalModalOpen = false;
    void createNewTerminal(
      account.id,
      true,
      null,
      newTerminalAgentId,
      null,
      newTerminalWorkspacePath,
    );
  });

  document.querySelector<HTMLButtonElement>("#loginNewTerminal")?.addEventListener("click", () => {
    const account = readNewTerminalModalForm();
    if (!account || !settings) {
      statusText = "Choisis ou ajoute un compte";
      render();
      return;
    }
    const environmentPath = userEnvironmentPath(newTerminalWorkspacePath);
    if (!environmentPath) {
      statusText = "Choisis un environnement avant d'ouvrir le terminal de connexion";
      render();
      return;
    }
    newTerminalWorkspacePath = environmentPath;
    setCurrentWorkspace(environmentPath);
    terminalFolderFilter = environmentPath;
    void upsertWorkspaceRegistry(environmentPath);
    const agent = newTerminalAgent();
    if (!agent?.loginCommand) {
      statusText = "Cet agent n'a pas de commande de login";
      render();
      return;
    }
    newTerminalModalOpen = false;
    void createNewTerminal(
      account.id,
      true,
      agentSubcommand(agent, agent.loginCommand),
      agent.id,
      null,
      newTerminalWorkspacePath,
    );
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

  // Barre latérale : « Discussions » (à la place de l'ancien « Comptes ») ouvre
  // la liste des conversations avec le sélecteur de compte de reprise.
  document.querySelector<HTMLButtonElement>("#sideDiscussions")?.addEventListener("click", () => {
    setActiveView("discussions");
  });
  // « Paramètres » : page dédiée qui héberge désormais l'accès Comptes & pool.
  document.querySelector<HTMLButtonElement>("#settingsToggle")?.addEventListener("click", () => {
    setActiveView("settings");
  });
  document.querySelector<HTMLButtonElement>("#settingsAccounts")?.addEventListener("click", () => {
    setActiveView("pool");
  });
  document.querySelector<HTMLButtonElement>("#settingsAgents")?.addEventListener("click", () => {
    openAgentsModal();
  });

  document.querySelector<HTMLButtonElement>("#limitsToggle")?.addEventListener("click", () => {
    setActiveView("limits");
  });

  document.querySelector<HTMLButtonElement>("#refreshLimits")?.addEventListener("click", () => {
    void refreshLimitStatus();
  });

  document.querySelectorAll<HTMLButtonElement>("[data-relogin-account]").forEach((button) => {
    button.addEventListener("click", () => {
      const accountId = button.dataset.reloginAccount;
      if (accountId) void reloginAccount(accountId);
    });
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
    if (userEnvironmentPath(currentWorkspace())) setActiveView("room");
    else openTerminalEnvironmentMenu();
  });

  document.querySelector<HTMLButtonElement>("#auditToggle")?.addEventListener("click", () => {
    void toggleAudit();
  });

  document.querySelector<HTMLButtonElement>("#auditRun")?.addEventListener("click", () => {
    void runAudit(auditViewLabelFor("audit"));
  });

  document.querySelector<HTMLDivElement>("#auditList")?.addEventListener("click", (event) => {
    const row = (event.target as HTMLElement).closest<HTMLElement>("[data-audit-selector]");
    if (row?.dataset.auditSelector) highlightAuditTarget(row.dataset.auditSelector);
  });

  document.querySelector<HTMLButtonElement>("#skillsToggle")?.addEventListener("click", () => {
    setActiveView("skills");
  });

  document.querySelector<HTMLButtonElement>("#skillsRefresh")?.addEventListener("click", () => {
    void refreshSkills();
  });

  document.querySelector<HTMLDivElement>("#skillsList")?.addEventListener("click", (event) => {
    const target = event.target as HTMLElement;
    const applyEl = target.closest<HTMLElement>("[data-skill-apply]");
    if (applyEl?.dataset.skillApply) {
      void applySkill(applyEl.dataset.skillApply);
      return;
    }
    const copyEl = target.closest<HTMLElement>("[data-skill-copy]");
    if (copyEl?.dataset.skillCopy) void copySkill(copyEl.dataset.skillCopy);
  });

  document.querySelector<HTMLButtonElement>("#roomRefresh")?.addEventListener("click", () => {
    void refreshRoom();
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

  document.querySelectorAll<HTMLButtonElement>("[data-open-discussions]").forEach((button) => {
    button.addEventListener("click", () => setActiveView("discussions"));
  });

  const returnToChat = () => {
    activeView = "chat";
    statusText = expertChatStatusText();
    startAllExpertChatWork();
    render();
  };
  document.querySelector<HTMLButtonElement>("#chatHome")?.addEventListener("click", returnToChat);
  document.querySelector<HTMLButtonElement>("#adminBackChat")?.addEventListener("click", returnToChat);
  document.querySelector<HTMLButtonElement>("#newChatSide")?.addEventListener("click", openNewChat);
  document.querySelector<HTMLButtonElement>("#chatSidebarClose")?.addEventListener("click", () => {
    document.body.classList.remove("chat-sidebar-open");
  });
  document.querySelector<HTMLButtonElement>("#chatSidebarScrim")?.addEventListener("click", () => {
    document.body.classList.remove("chat-sidebar-open");
  });
  document.querySelector<HTMLInputElement>("#chatSidebarSearch")?.addEventListener("input", (event) => {
    chatSidebarSearch = (event.currentTarget as HTMLInputElement).value;
    const host = document.querySelector<HTMLElement>("#chatSideConversations");
    if (host) {
      host.innerHTML = renderChatSidebarConversations();
      createIcons({ icons: lucideIcons });
      bindDiscussionRowUi();
      bindWorkspaceSwitcherUi(host);
    }
  });

  document.querySelector<HTMLButtonElement>("#refreshDiscussions")?.addEventListener("click", () => {
    void refreshDiscussions();
  });

  // Vue conversation : navigation, composer, arret et copie des blocs de code.
  document.querySelector<HTMLButtonElement>("#chatBack")?.addEventListener("click", () => {
    if (window.matchMedia("(max-width: 760px)").matches) {
      document.body.classList.add("chat-sidebar-open");
    } else {
      setActiveView("discussions");
    }
  });
  document.querySelector<HTMLButtonElement>("#chatRefresh")?.addEventListener("click", () => {
    if (chatDiscussion) void loadChatTranscript();
    else void refreshDiscussions();
  });
  document.querySelector<HTMLButtonElement>("#chatHistoryToggle")?.addEventListener("click", () => {
    chatHistoryOpen = !chatHistoryOpen;
    render();
  });
  document.querySelector<HTMLButtonElement>("#chatHistoryClose")?.addEventListener("click", () => {
    chatHistoryOpen = false;
    render();
  });
  document.querySelectorAll<HTMLButtonElement>("#chatPanel [data-chat-history-message]").forEach((button) => {
    button.addEventListener("click", () => {
      const index = Number(button.dataset.chatHistoryMessage);
      if (!Number.isInteger(index)) return;
      const reveal = () => {
        const message = document.querySelector<HTMLElement>(`#chat-message-${index}`);
        message?.scrollIntoView({ behavior: "smooth", block: "center" });
        message?.classList.add("chat-msg--located");
        window.setTimeout(() => message?.classList.remove("chat-msg--located"), 1400);
      };
      if (window.matchMedia("(max-width: 760px)").matches) {
        chatHistoryOpen = false;
        render();
        window.requestAnimationFrame(reveal);
      } else {
        reveal();
      }
    });
  });
  document.querySelector<HTMLButtonElement>("#chatNew")?.addEventListener("click", openNewChat);
  document.querySelector<HTMLButtonElement>("#chatStop")?.addEventListener("click", () => {
    void stopCurrentChatTurn();
  });

  document.querySelector<HTMLButtonElement>("#closeWorkspaceLiveGraph")?.addEventListener("click", () => {
    closeWorkspaceLiveGraph();
  });
  document.querySelector<HTMLDivElement>("#workspaceLiveGraphBackdrop")?.addEventListener("click", (event) => {
    if (event.target === event.currentTarget) closeWorkspaceLiveGraph();
  });
  document
    .querySelector<HTMLButtonElement>("#chatPanel [data-chat-action='quota-switch'][data-quota-account]")
    ?.addEventListener("click", (event) => {
      const targetAccountId = (event.currentTarget as HTMLButtonElement).dataset.quotaAccount;
      if (chatDiscussion && targetAccountId) {
        void continueDiscussionWith(chatDiscussion, targetAccountId);
      }
    });

  const chatPrompt = document.querySelector<HTMLTextAreaElement>("#chatPrompt");
  const resizeChatPrompt = () => {
    if (!chatPrompt) return;
    chatPrompt.style.height = "0px";
    chatPrompt.style.height = `${Math.min(chatPrompt.scrollHeight, 190)}px`;
  };
  chatPrompt?.addEventListener("input", () => {
    chatDraft = chatPrompt.value;
    resizeChatPrompt();
  });
  chatPrompt?.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
      event.preventDefault();
      void sendChatMessage();
    }
  });
  resizeChatPrompt();
  document.querySelector<HTMLFormElement>("#chatComposer")?.addEventListener("submit", (event) => {
    event.preventDefault();
    void sendChatMessage();
  });
  document.querySelector<HTMLSelectElement>("#chatMode")?.addEventListener("change", (event) => {
    chatMode = (event.currentTarget as HTMLSelectElement).value as ChatMode;
  });
  const chatModelInput = document.querySelector<HTMLInputElement>("#chatModel");
  const commitChatPreferences = () => {
    const account = chatSelectedAccount();
    if (!account) return false;
    const preferences = readChatPreferences(account);
    chatModelInput?.setCustomValidity(preferences.error ?? "");
    if (preferences.error) {
      chatModelInput?.reportValidity();
      statusText = preferences.error;
      return false;
    }
    if (preferences.changed) persistChatPreferences(account.id);
    return true;
  };
  chatModelInput?.addEventListener("input", () => chatModelInput.setCustomValidity(""));
  chatModelInput?.addEventListener("change", () => {
    if (commitChatPreferences()) render();
  });
  chatModelInput?.addEventListener("keydown", (event) => {
    if (event.key !== "Enter") return;
    event.preventDefault();
    chatModelInput.blur();
  });
  document
    .querySelector<HTMLSelectElement>("#chatReasoningEffort")
    ?.addEventListener("change", commitChatPreferences);
  document.querySelectorAll<HTMLButtonElement>("#chatPanel [data-chat-starter]").forEach((button) => {
    button.addEventListener("click", () => {
      chatDraft = button.dataset.chatStarter ?? "";
      const prompt = document.querySelector<HTMLTextAreaElement>("#chatPrompt");
      if (prompt) {
        prompt.value = chatDraft;
        prompt.dispatchEvent(new Event("input"));
        prompt.focus();
        prompt.setSelectionRange(prompt.value.length, prompt.value.length);
      }
    });
  });
  // Delegation sur le conteneur : les boutons copier sont recrees a chaque
  // patch du fil, le listener sur #chatFeed (stable) les couvre tous.
  document.querySelector<HTMLDivElement>("#chatFeed")?.addEventListener("click", (event) => {
    const target = event.target as HTMLElement | null;
    const button = target?.closest<HTMLButtonElement>(".chat-code-copy");
    if (!button) return;
    const code = button.closest(".chat-code")?.querySelector("code")?.textContent ?? "";
    if (!code) return;
    void navigator.clipboard.writeText(code).then(() => {
      button.classList.add("copied");
      window.setTimeout(() => button.classList.remove("copied"), 1200);
    });
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
      "#poolNewAccountLabel, #poolNewAccountProxy, #poolNewAccountBypass, #poolNewAccountModel, #poolNewAccountReasoningEffort",
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
      void removeAccount(confirmBtn.dataset.removeAccountConfirm ?? null, false);
      return;
    }
    const purgeBtn = target.closest<HTMLElement>("[data-remove-account-purge]");
    if (purgeBtn) {
      const id = purgeBtn.dataset.removeAccountPurge ?? null;
      const acc = poolStatus?.accounts?.find((item) => item.id === id);
      const home = acc?.codexHome ?? "";
      const confirmed = window.confirm(
        `Supprimer définitivement le compte « ${acc?.label ?? id ?? ""} » ET son environnement sur le disque ?\n\n${home}\n\nCette action est irréversible : auth.json, sessions, config… seront effacés.`,
      );
      if (confirmed) {
        void removeAccount(id, true);
      } else {
        pendingDeleteAccountId = null;
        render();
      }
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
    void deleteSelectedAccount();
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
    void invoke<AppSettings>("save_settings", { settings })
      .then(async (updated) => {
        settings = updated;
        const account = selectedAccount();
        if (account) await provisionAccountHome(account);
        statusText = account?.bypass
          ? "Bypass active pour ce compte"
          : "Bypass desactive : sandbox workspace-write active";
        render();
      })
      .catch((error) => {
        statusText = String(error);
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
  const accountModelInput = document.querySelector<HTMLInputElement>("#accountModel");
  const accountReasoningEffortSelect =
    document.querySelector<HTMLSelectElement>("#accountReasoningEffort");

  if (
    account &&
    (accountLabel ||
      accountHome ||
      projectDir ||
      proxySelect ||
      accountBypass ||
      accountModelInput ||
      accountReasoningEffortSelect)
  ) {
    if (accountLabel) account.label = accountLabel.value.trim() || account.label;
    if (accountHome) account.codexHome = accountHome.value.trim() || account.codexHome;
    if (projectDir) account.projectDir = projectDir.value.trim() || null;
    if (settings.proxyControlsEnabled) {
      account.proxyId = proxySelect?.value || null;
    }
    if (accountBypass) account.bypass = accountBypass.checked;
    if (accountModelInput) account.model = accountModelInput.value.trim() || DEFAULT_CODEX_MODEL;
    if (accountReasoningEffortSelect) {
      account.reasoningEffort = normalizeCodexReasoningEffort(accountReasoningEffortSelect.value);
    }
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
  folderPath: string,
): TerminalSession => {
  const capturedEnvironment = userEnvironmentPath(folderPath);
  if (!capturedEnvironment) {
    throw new Error("Environnement terminal obligatoire");
  }
  const terminal = new Terminal({
    cursorBlink: true,
    cursorStyle: "bar",
    fontFamily: "Cascadia Mono, Consolas, monospace",
    fontSize: 13,
    lineHeight: 1.15,
    theme: {
      // Noir & blanc profond : chrome du terminal en niveaux de gris (fond
      // noir absolu, texte/curseur blancs). Les couleurs ANSI (red/green/...)
      // restent fonctionnelles pour la lisibilite des sorties (git diff, ls...).
      background: "#000000",
      foreground: "#f4f4f4",
      cursor: "#ffffff",
      selectionBackground: "#3a3a3a",
      black: "#1a1a1a",
      red: "#f06f6c",
      green: "#8fd694",
      yellow: "#ffd166",
      blue: "#78a6d9",
      magenta: "#d29bd9",
      cyan: "#6ec6bd",
      white: "#f4f4f4",
      brightBlack: "#6a6a6a",
      brightRed: "#ff8a82",
      brightGreen: "#a7e9aa",
      brightYellow: "#ffe08a",
      brightBlue: "#94c1f0",
      brightMagenta: "#e7b3ef",
      brightCyan: "#8de1d7",
      brightWhite: "#ffffff",
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
    folderPath: capturedEnvironment,
    workspaceId: null,
    workspacePath: null,
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

const mountExpertTerminals = () => {
  const sessions = expertTerminalSessions();
  const sessionByKey = new Map(sessions.map((session) => [session.key, session]));
  const fontSize = sessions.length > 9 ? 10 : sessions.length > 4 ? 11 : 12;

  document.querySelectorAll<HTMLDivElement>("[data-terminal-host]").forEach((host) => {
    const session = sessionByKey.get(host.dataset.terminalHost ?? "");
    if (!session) return;
    session.terminal.options.fontSize = session.key === expertTerminalFullscreenKey ? 13 : fontSize;
    if (session.terminal.element) {
      host.appendChild(session.terminal.element);
    } else {
      session.terminal.open(host);
    }
  });

  const modalOpen =
    newTerminalModalOpen ||
    agentsModalOpen ||
    workspaceModalOpen ||
    terminalEnvironmentMenuOpen;
  const focusKey = requestTerminalFocusKey ?? focusedTerminalKeyBeforeRender;
  if (!modalOpen && focusKey) sessionByKey.get(focusKey)?.terminal.focus();
  requestTerminalFocusKey = null;
  requestAnimationFrame(() => fitAndResizeExpertTerminals());
};

const createNewTerminal = async (
  accountId = selectedAccountId,
  settingsAlreadyRead = false,
  commandOverride: string | null = null,
  agentId: string | null = null,
  resumeSessionId: string | null = null,
  folderPath: string | null | undefined = undefined,
) => {
  if (!settings) return null;
  const environmentPath = userEnvironmentPath(folderPath);
  if (!environmentPath) {
    statusText = "Creation bloquee: choisis d'abord un environnement";
    render();
    return null;
  }

  activeView = "terminal";
  await ensureTerminalsRestored();
  if (terminalSessions.length + pendingTerminalCreations >= EXPERT_MAX_TERMINALS) {
    statusText = `Limite atteinte: ${EXPERT_MAX_TERMINALS} terminaux maximum dans une fenetre`;
    render();
    return null;
  }
  pendingTerminalCreations += 1;
  let terminalSlotReserved = true;
  const releaseTerminalSlot = () => {
    if (terminalSlotReserved) {
      terminalSlotReserved = false;
      pendingTerminalCreations -= 1;
    }
  };

  if (!settingsAlreadyRead) {
    readSettingsForm();
  }
  const account = settings.accounts.find((candidate) => candidate.id === accountId) ?? null;
  if (!account) {
    releaseTerminalSlot();
    return null;
  }

  const agents = settings.agents;
  const activeId = settings.activeAgentId ?? null;
  let chosenAgentId =
    (agentId && agents.some((agent) => agent.id === agentId) && agentId) ||
    (activeId && agents.some((agent) => agent.id === activeId) && activeId) ||
    agents[0]?.id ||
    "codex";

  // L'agent CLI lance doit correspondre au provider du compte : un compte Claude
  // se lance avec l'agent Claude (CLAUDE_CONFIG_DIR + `claude`), un compte Codex
  // avec Codex. Sinon la variable de home et la commande se contrediraient. On
  // ne force que pour les agents CLI "premier rang" (on laisse les agents IDE /
  // customs intacts).
  const wantedProvider = accountProvider(account);
  const chosenAgent = agentById(chosenAgentId);
  if (isFirstPartyAgent(chosenAgent) && agentProvider(chosenAgent) !== wantedProvider) {
    chosenAgentId = providerAgentId(wantedProvider);
  }

  selectedAccountId = account.id;
  settings.defaultAccountId = account.id;
  settings.activeAgentId = chosenAgentId;
  try {
    settings = await invoke<AppSettings>("save_settings", { settings });
  } catch (error) {
    releaseTerminalSlot();
    throw error;
  }

  const savedAccount = settings.accounts.find((candidate) => candidate.id === account.id) ?? null;
  if (!savedAccount) {
    releaseTerminalSlot();
    return null;
  }

  const session = createTerminalSession(
    savedAccount,
    proxyForAccount(savedAccount),
    chosenAgentId,
    environmentPath,
  );
  session.resumeSessionId = resumeSessionId;
  if (resumeSessionId) {
    session.codexSessionId = resumeSessionId;
    claimedSessionIds.add(resumeSessionId);
  }
  terminalSessions.push(session);
  releaseTerminalSlot();
  activateTerminalSession(session);
  requestTerminalFocusKey = session.key;
  activeView = "terminal";
  stopLimitPoll();
  stopUsagePoll();
  stopDiscussionsPoll();
  stopRoomPoll();
  stopChatSync();
  stopChatTurnPoll();
  statusText = "Demarrage terminal";
  render();

  await startTerminalSession(session, commandOverride);
  persistTerminalSessions();
  return session;
};

const startTerminalSession = async (session: TerminalSession, commandOverride: string | null = null) => {
  if (!settings) return;
  const folder = userEnvironmentPath(session.folderPath);
  if (!folder) {
    session.running = false;
    session.status = "Bloque";
    statusText = "Demarrage refuse: aucun environnement selectionne";
    render();
    return;
  }

  await waitForFrame();
  fitAndResizeTerminal(session);

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
    // Workspace capture dans CETTE session :
    //  - web  : envoye au serveur comme `workspacePath` (cwd = ce dossier ; le
    //           serveur ignore alors `repoUrl`) ;
    //  - desktop : envoye comme `projectDir` (override du dossier du compte).
    const started = await invoke<number | TerminalStartResponse>("start_terminal", {
      id: requestedId,
      accountId: session.accountId,
      repoUrl: isRemoteMode() ? session.projectDir ?? "" : undefined,
      workspacePath: isRemoteMode() ? folder ?? undefined : undefined,
      projectDir: !isRemoteMode() ? folder ?? undefined : undefined,
      branch: null,
      cols: session.terminal.cols,
      rows: session.terminal.rows,
      command: commandOverride ?? autoRunCommand,
      agentId: session.agentId,
    });
    const ptyId = typeof started === "number" ? started : started.id;
    session.ptyId = ptyId;
    session.workspaceId = typeof started === "number" ? null : started.workspaceId;
    session.workspacePath = typeof started === "number" ? null : started.workspacePath;
    session.running = true;
    session.status = "Actif";
    statusText = "Terminal actif";
    if (settings.autoRunCodex && isIde && sessionAgent && !commandOverride) {
      // Utilise le workspace capture par cette session, meme si l'utilisateur
      // en a selectionne un autre pendant le demarrage du PTY.
      void launchIde(sessionAgent, session.workspacePath ?? session.folderPath ?? session.projectDir);
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
  if (expertTerminalFullscreenKey === key) expertTerminalFullscreenKey = null;
  const closedWorkspaceKey = terminalWorkspaceDescriptor(session).key;
  const ptyId = session.ptyId;
  session.ptyId = null;
  session.running = false;
  session.terminal.dispose();

  if (activeTerminalKey === key) {
    const replacement =
      terminalSessions.find(
        (candidate) => terminalWorkspaceDescriptor(candidate).key === closedWorkspaceKey,
      ) ?? terminalSessions[Math.max(0, index - 1)] ?? terminalSessions[0] ?? null;
    if (replacement) {
      activateTerminalSession(replacement);
    } else {
      activeTerminalKey = null;
    }
  }

  statusText = "Terminal ferme";
  render();
  persistTerminalSessions();

  if (ptyId !== null) {
    await invoke("stop_terminal", { id: ptyId }).catch(() => undefined);
  }
  await persistTerminalDiscussionFolder(session).catch(() => undefined);
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

const expertChatKeyFromElement = (element: Element | null): string | null => {
  return element?.closest<HTMLElement>("[data-chat-panel]")?.dataset.chatPanel || null;
};

const expertChatKeyAtPointer = (): string | null => {
  const pointedElement = lastPointerClientX !== null && lastPointerClientY !== null
    ? document.elementFromPoint(lastPointerClientX, lastPointerClientY)
    : null;
  const pointedKey = expertChatKeyFromElement(pointedElement);
  if (pointedKey) return pointedKey;

  return document.querySelector<HTMLElement>("[data-chat-panel]:hover")?.dataset.chatPanel || null;
};

const closeHoveredExpertChat = (action: ChatHoverShortcutAction): boolean => {
  if (activeView !== "chat") return false;
  if (document.querySelector(".modal-backdrop")) return false;

  const key = expertChatKeyAtPointer();
  const pane = expertChatPanes.find((candidate) => candidate.key === key);
  if (!pane) return false;

  if (action === "close-chat-and-discussion") {
    void closeExpertChatAndDiscussion(pane);
  } else {
    closeExpertChatPane(pane);
  }
  return true;
};

const toggleHoveredExpertFullscreen = (): boolean => {
  if (activeView === "terminal") {
    const hoveredPane = document.querySelector<HTMLElement>("[data-expert-terminal-pane]:hover");
    const key = expertTerminalFullscreenKey ?? hoveredPane?.dataset.expertTerminalPane;
    const session = terminalSessions.find((candidate) => candidate.key === key);
    if (!session) return false;
    toggleExpertTerminalFullscreen(session);
    return true;
  }

  if (activeView === "chat") {
    const hoveredPane = document.querySelector<HTMLElement>("[data-chat-panel]:hover");
    const key = expertChatFullscreenKey ?? hoveredPane?.dataset.chatPanel;
    const pane = expertChatPanes.find((candidate) => candidate.key === key);
    if (!pane) return false;
    toggleExpertChatFullscreen(pane);
    return true;
  }

  return false;
};

const handleHoveredExpertTerminalArrows = (event: KeyboardEvent): boolean => {
  if (activeView !== "terminal") return false;
  const hoveredPane = document.querySelector<HTMLElement>("[data-expert-terminal-pane]:hover");
  const key = hoveredPane?.dataset.expertTerminalPane ?? expertTerminalFullscreenKey;
  if (!key) return false;
  const session = terminalSessions.find((candidate) => candidate.key === key);
  if (!session) return false;

  if (event.key === "ArrowRight") {
    void closeTerminalSession(session.key);
    return true;
  }
  if (event.key === "ArrowUp") {
    if (expertTerminalFullscreenKey !== session.key) {
      toggleExpertTerminalFullscreen(session);
    }
    return true;
  }
  if (event.key === "ArrowDown") {
    if (expertTerminalFullscreenKey === session.key) {
      toggleExpertTerminalFullscreen(session);
    }
    return true;
  }
  return false;
};

const setupEvents = async () => {
  document.addEventListener("fullscreenchange", scheduleFullscreenSync);
  document.addEventListener("webkitfullscreenchange", scheduleFullscreenSync);
  window.addEventListener("resize", scheduleFullscreenSync);
  window.addEventListener("pointermove", (event) => {
    lastPointerClientX = event.clientX;
    lastPointerClientY = event.clientY;
  }, true);
  window.addEventListener("pointerdown", (event) => {
    lastPointerClientX = event.clientX;
    lastPointerClientY = event.clientY;
  }, true);
  document.addEventListener("pointerleave", () => {
    lastPointerClientX = null;
    lastPointerClientY = null;
  });
  window.addEventListener("blur", () => {
    lastPointerClientX = null;
    lastPointerClientY = null;
  });

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
    void persistTerminalDiscussionFolder(session).catch(() => undefined);
  });

  window.addEventListener("resize", () => {
    syncChatSidebarWidthDom();
    fitAndResizeVisibleTerminals();
  });

  window.addEventListener("keydown", (event) => {
    const isAzertyBacktick =
      event.key === "Dead" &&
      event.code === "Digit7" &&
      (event.altKey || event.getModifierState("AltGraph"));
    const isEnvironmentShortcut =
      event.key === "`" || event.code === "Backquote" || isAzertyBacktick;
    if (!isEnvironmentShortcut || event.repeat || !settings) return;
    if (
      !terminalEnvironmentMenuOpen &&
      (newTerminalModalOpen || agentsModalOpen || workspaceModalOpen || workspaceLiveGraphOpen)
    ) {
      return;
    }
    event.preventDefault();
    event.stopImmediatePropagation();
    toggleTerminalEnvironmentMenu();
  }, true);

  window.addEventListener("keydown", (event) => {
    const action = chatHoverShortcutAction(event);
    if (!action || !closeHoveredExpertChat(action)) return;
    event.preventDefault();
    event.stopImmediatePropagation();
  }, true);

  window.addEventListener("keydown", (event) => {
    const isSpaceBar = event.code === "Space" || event.key === " ";
    if (!isSpaceBar || event.repeat || event.shiftKey || event.ctrlKey || event.altKey || event.metaKey) return;
    const target = event.target as HTMLElement | null;
    const tag = target?.tagName;
    if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || target?.isContentEditable === true) return;
    if (document.querySelector(".modal-backdrop")) return;
    if (!toggleHoveredExpertFullscreen()) return;
    event.preventDefault();
    event.stopImmediatePropagation();
  }, true);

  window.addEventListener("keydown", (event) => {
    if (
      event.key !== "ArrowUp" &&
      event.key !== "ArrowDown" &&
      event.key !== "ArrowRight"
    ) {
      return;
    }
    if (event.repeat || event.shiftKey || event.ctrlKey || event.altKey || event.metaKey) return;
    const target = event.target as HTMLElement | null;
    const tag = target?.tagName;
    if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || target?.isContentEditable === true) return;
    if (document.querySelector(".modal-backdrop")) return;
    if (!handleHoveredExpertTerminalArrows(event)) return;
    event.preventDefault();
    event.stopImmediatePropagation();
  }, true);

  window.addEventListener("keydown", (event) => {
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "n") {
      event.preventDefault();
      openNewChat();
      return;
    }

    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "k") {
      event.preventDefault();
      if (!window.matchMedia("(max-width: 760px)").matches && displayedChatSidebarWidth() === 0) {
        setChatSidebarWidth(defaultChatSidebarWidth(window.innerWidth));
      }
      document.body.classList.add("chat-sidebar-open");
      document.querySelector<HTMLInputElement>("#chatSidebarSearch")?.focus();
      return;
    }

    if (event.key === "Escape" && terminalEnvironmentMenuOpen) {
      event.preventDefault();
      closeTerminalEnvironmentMenu();
      return;
    }

    if (event.key === "Escape" && document.body.classList.contains("chat-sidebar-open")) {
      document.body.classList.remove("chat-sidebar-open");
      return;
    }

    if (event.key === "Escape" && agentsModalOpen) {
      event.preventDefault();
      closeAgentsModal();
      return;
    }

    if (event.key === "Escape" && newChatModalOpen) {
      event.preventDefault();
      closeNewChatModal();
      return;
    }

    if (event.key === "Escape" && newTerminalModalOpen) {
      event.preventDefault();
      closeNewTerminalModal();
      return;
    }

    if (event.key === "Escape" && workspaceLiveGraphOpen) {
      event.preventDefault();
      closeWorkspaceLiveGraph();
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
  chatAccountId = selectedAccountId;
  poolNewAccountBypass = settings.codexBypass ?? true;
  // Migre le registre de workspaces (localStorage -> settings) et fixe le
  // filtre par defaut, avant le premier rendu de la barre laterale.
  await syncWorkspaceRegistry();
  expertGridLayout = loadExpertGridLayout();
  expertChatsPerPage = loadExpertChatsPerPage();
  chatSidebarWidth = loadChatSidebarWidth();
  isFullscreen = await appWindow.isFullscreen().catch(() => false);
  await setupEvents();
  activeView = "chat";
  await refreshDiscussions();
  restoreExpertChats();
  render();
  startDiscussionsPoll();
  startAllExpertChatWork();
  expertChatPanes.forEach((pane) => void loadChatModelCatalog(pane.accountId));
};

window.addEventListener("beforeunload", () => {
  persistTerminalSessions();
  persistExpertChats();
  unlistenData?.();
  unlistenExit?.();
  stopPoolPoll();
  stopLimitPoll();
  stopUsagePoll();
  stopKombaiPoll();
  stopDiscussionsPoll();
  stopChatSync();
  stopChatTurnPoll();
  stopAllExpertChatWork();
  // Best-effort : evite de laisser un code-server orphelin apres fermeture.
  void invoke("kombai_stop").catch(() => undefined);
  terminalSessions.forEach((session) => {
    if (session.ptyId !== null) {
      void invoke("stop_terminal", { id: session.ptyId }).catch(() => undefined);
    }
  });
});

initPwaSupport();

void boot().catch((error) => {
  app.innerHTML = `<main class="boot error">${escapeHtml(String(error))}</main>`;
});
