// Vue conversation interactive, facon OpenCode.
//
// Module PUR (donnees -> chaines HTML) : l'etat, les appels backend et le
// binding des listeners restent dans main.ts. Le fil (#chatFeed) est patche de
// maniere ciblee pour conserver le scroll et le brouillon pendant le streaming.

import { escapeHtml, renderMarkdown } from "./markdown";

export type ChatRole = "user" | "assistant";
export type ChatMode = "build" | "plan" | "ask";
export type ChatTurnStatus = "running" | "completed" | "failed" | "cancelled" | "idle";

export type ChatMessage = {
  role: ChatRole;
  text: string;
  // Secondes unix ; 0 = ligne sans horodatage.
  timestamp: number;
};

export type ChatActivity = {
  id: string;
  kind: string;
  label: string;
  detail?: string | null;
  status: string;
};

export type ChatAccountOption = {
  id: string;
  label: string;
  providerLabel: string;
  model: string;
};

export type ChatSelectOption = {
  value: string;
  label: string;
};

export type ChatQuotaSuggestion = {
  accountId: string;
  accountLabel: string;
  remainingPercent: number;
  busy: boolean;
};

export type ChatSyncState =
  | "connecting"
  | "live"
  | "reconnecting"
  | "closed"
  | "unsupported"
  | "polling";

export type ChatPanelModel = {
  title: string;
  subtitle: string;
  providerLabel: string;
  loading: boolean;
  error: string | null;
  truncated: boolean;
  syncState: ChatSyncState;
  messages: ChatMessage[];
  activities: ChatActivity[];
  turnStatus: ChatTurnStatus;
  turnError: string | null;
  quotaSuggestion: ChatQuotaSuggestion | null;
  accounts: ChatAccountOption[];
  selectedAccountId: string;
  selectedModel: string;
  modelSuggestions: string[];
  selectedReasoningEffort: string;
  reasoningEffortOptions: ChatSelectOption[];
  supportsReasoningEffort: boolean;
  mode: ChatMode;
  draft: string;
  newConversation: boolean;
  workspaceLabel: string;
  historyOpen: boolean;
};

export type ChatPanelRenderOptions = {
  instanceId?: string;
  paneIndex?: number;
  active?: boolean;
  compact?: boolean;
  fullscreen?: boolean;
};

export const chatSyncLabel = (state: ChatSyncState): string => {
  switch (state) {
    case "live":
      return "En direct";
    case "connecting":
      return "Connexion…";
    case "reconnecting":
      return "Reconnexion…";
    case "polling":
    case "unsupported":
      return "Actualisation auto";
    default:
      return "Local";
  }
};

const timeLabel = (timestamp: number): string => {
  const date = new Date(timestamp * 1000);
  const time = date.toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" });
  if (date.toDateString() === new Date().toDateString()) return time;
  return `${date.toLocaleDateString("fr-FR", { day: "2-digit", month: "2-digit" })} ${time}`;
};

const renderMessage = (
  message: ChatMessage,
  providerLabel: string,
  index: number,
  showIdentity: boolean,
  instanceId = "",
): string => `
  <article id="${instanceId ? `chat-message-${instanceId}-${index}` : `chat-message-${index}`}" data-chat-message-index="${index}" class="chat-msg chat-msg--${message.role}">
    ${showIdentity
      ? `<div class="chat-msg-meta">
          <span class="chat-msg-avatar ${message.role}">${message.role === "user" ? "V" : "S"}</span>
          <span class="chat-msg-role">${message.role === "user" ? "Vous" : escapeHtml(providerLabel || "Assistant")}</span>
          ${message.timestamp ? `<span class="chat-msg-time">${escapeHtml(timeLabel(message.timestamp))}</span>` : ""}
        </div>`
      : ""}
    <div class="chat-msg-body">${renderMarkdown(message.text)}</div>
  </article>`;

const activityIcon = (kind: string): string => {
  switch (kind) {
    case "edit":
      return "save";
    case "search":
      return "search";
    case "plan":
      return "list-checks";
    case "tool":
      return "wrench";
    case "command":
      return "play";
    default:
      return "sparkles";
  }
};

const renderActivities = (activities: ChatActivity[]): string => {
  if (!activities.length) return "";
  return `<div class="chat-activities" aria-label="Activites de l'agent">
    ${activities
      .map(
        (activity) => `
        <div class="chat-activity chat-activity--${escapeHtml(activity.status)}">
          <span class="chat-activity-icon"><i data-lucide="${activityIcon(activity.kind)}"></i></span>
          <span class="chat-activity-copy">
            <strong>${escapeHtml(activity.label)}</strong>
            ${activity.detail ? `<small>${escapeHtml(activity.detail)}</small>` : ""}
          </span>
          <span class="chat-activity-state" aria-hidden="true"></span>
        </div>`,
      )
      .join("")}
  </div>`;
};

const renderWelcome = (): string => `
  <div class="chat-welcome">
    <span class="chat-welcome-mark"><i data-lucide="sparkles"></i></span>
    <h1>Que voulez-vous construire ?</h1>
    <p>Decrivez le resultat attendu. L'agent explore l'environnement, modifie les fichiers et vous repond ici.</p>
    <div class="chat-starters">
      <button type="button" data-chat-starter="Analyse ce projet et explique-moi clairement son architecture.">
        <strong>Comprendre le projet</strong><span>Architecture, flux et points d'entree</span>
      </button>
      <button type="button" data-chat-starter="Aide-moi a diagnostiquer ce probleme : ">
        <strong>Trouver un bug</strong><span>Reproduction, cause et correction</span>
      </button>
      <button type="button" data-chat-starter="Ameliore l'interface de cette application, notamment son accessibilite et son responsive.">
        <strong>Ameliorer l'interface</strong><span>Accessibilite, responsive et finition</span>
      </button>
    </div>
  </div>`;

export const renderChatFeedInner = (model: ChatPanelModel, instanceId = ""): string => {
  if (model.loading && model.messages.length === 0) {
    return `<div class="chat-empty"><span class="chat-loader"></span>Chargement de la conversation…</div>`;
  }
  if (model.error && model.messages.length === 0) {
    return `<div class="chat-error">${escapeHtml(model.error)}</div>`;
  }

  const notice = model.truncated
    ? `<div class="chat-notice">Discussion tres longue : seuls les derniers messages sont affiches.</div>`
    : "";
  const messages = model.messages.length
    ? model.messages
        .map((message, index) => {
          const previousMessage = model.messages[index - 1];
          const showIdentity = message.role !== "assistant" || previousMessage?.role !== "assistant";
          return renderMessage(message, model.providerLabel, index, showIdentity, instanceId);
        })
        .join("")
    : renderWelcome();
  const shouldShowThinking =
    model.turnStatus === "running" &&
    (model.messages.length === 0 || model.messages[model.messages.length - 1]?.role !== "assistant");
  const thinking = shouldShowThinking
    ? `<article class="chat-msg chat-msg--assistant chat-msg--thinking">
        <div class="chat-msg-meta"><span class="chat-msg-avatar assistant">S</span><span class="chat-msg-role">${escapeHtml(model.providerLabel || "Assistant")}</span></div>
        <div class="chat-thinking"><span></span><span></span><span></span><em>travaille dans l'environnement</em></div>
      </article>`
    : "";
  const turnError = model.turnError
    ? `<div class="chat-error chat-turn-error">${escapeHtml(model.turnError)}</div>`
    : "";
  const quotaSuggestion = model.quotaSuggestion
    ? `<div class="chat-quota-suggestion">
        <span>
          <strong>${escapeHtml(model.quotaSuggestion.accountLabel)}</strong> est le compte compatible
          qui possède le plus de quota (${Math.round(model.quotaSuggestion.remainingPercent)} % disponible).
        </span>
        <button
          type="button"
          class="tool-button primary"
          data-chat-action="quota-switch"
          data-quota-account="${escapeHtml(model.quotaSuggestion.accountId)}"
          ${model.quotaSuggestion.busy ? "disabled" : ""}
        >
          ${model.quotaSuggestion.busy ? "Déplacement…" : "Déplacer + continuer"}
        </button>
      </div>`
    : "";
  return notice + messages + renderActivities(model.activities) + thinking + turnError + quotaSuggestion;
};

const modelSuggestions = (model: ChatPanelModel): string =>
  Array.from(new Set([model.selectedModel, ...model.modelSuggestions].filter(Boolean)))
    .map((value) => `<option value="${escapeHtml(value)}"></option>`)
    .join("");

const reasoningEffortOptions = (model: ChatPanelModel): string => {
  if (!model.supportsReasoningEffort) {
    return `<option value="">Non applicable</option>`;
  }
  return model.reasoningEffortOptions
    .map(
      (option) =>
        `<option value="${escapeHtml(option.value)}" ${option.value === model.selectedReasoningEffort ? "selected" : ""}>${escapeHtml(option.label)}</option>`,
    )
    .join("");
};

const renderChatHistory = (model: ChatPanelModel, instanceId = ""): string => {
  if (!model.historyOpen) return "";
  const userMessages = model.messages
    .map((message, index) => ({ message, index }))
    .filter(({ message }) => message.role === "user");
  const content = userMessages.length
    ? `<ol class="chat-history-list">
        ${userMessages
          .map(
            ({ message, index }, position) => `
              <li>
                <button type="button" data-chat-history-message="${index}" title="Revenir a ce message dans le chat">
                  <span class="chat-history-index">${position + 1}</span>
                  <span class="chat-history-copy">${escapeHtml(message.text)}</span>
                  ${message.timestamp ? `<time>${escapeHtml(timeLabel(message.timestamp))}</time>` : ""}
                </button>
              </li>`,
          )
          .join("")}
      </ol>`
    : `<div class="chat-history-empty">Vous n'avez encore envoye aucun message dans ce chat.</div>`;
  return `
    <aside id="${instanceId ? `chatHistory-${instanceId}` : "chatHistory"}" data-chat-control="history" class="chat-history" aria-label="Historique de ce chat">
      <header>
        <div>
          <strong>Historique du chat</strong>
          <span>${userMessages.length} message(s) envoye(s)</span>
        </div>
        <button id="${instanceId ? `chatHistoryClose-${instanceId}` : "chatHistoryClose"}" data-chat-action="history-close" type="button" class="icon-button" title="Fermer l'historique" aria-label="Fermer l'historique">
          <i data-lucide="x"></i>
        </button>
      </header>
      ${model.truncated ? `<div class="chat-history-notice">Le debut de cette tres longue conversation n'est plus charge.</div>` : ""}
      ${content}
    </aside>`;
};

export const renderChatPanel = (
  model: ChatPanelModel,
  options: ChatPanelRenderOptions = {},
): string => {
  const running = model.turnStatus === "running";
  const userMessageCount = model.messages.filter((message) => message.role === "user").length;
  const instanceId = (options.instanceId ?? "").replace(/[^a-zA-Z0-9_-]/g, "-");
  const id = (base: string) => instanceId ? `${base}-${instanceId}` : base;
  const compact = options.compact === true;
  const fullscreen = options.fullscreen === true;
  const expertClass = instanceId
    ? `chat-panel--expert ${options.active ? "active" : ""} ${compact ? "chat-panel--compact" : ""} ${fullscreen ? "is-fullscreen" : ""}`
    : "";
  return `
  <section id="${id("chatPanel")}" data-chat-panel="${instanceId}" class="chat-panel ${expertClass} ${model.newConversation ? "chat-panel--new" : ""} ${model.historyOpen ? "chat-panel--history" : ""}">
    <header class="chat-head">
      ${compact ? "" : `<button id="${id("chatBack")}" data-chat-action="back" class="icon-button wide" title="Toutes les conversations" aria-label="Toutes les conversations">
        <i data-lucide="arrow-left"></i>
      </button>`}
      ${!compact && options.paneIndex ? `<span class="expert-chat-pane-index" title="Chat ${options.paneIndex}">${options.paneIndex}</span>` : ""}
      <div class="chat-head-main">
        <strong class="chat-title" title="${escapeHtml(model.title)}">${escapeHtml(model.title)}</strong>
        ${compact ? "" : `<span id="${id("chatSubtitle")}" data-chat-control="subtitle" class="chat-sub">${escapeHtml(model.subtitle)}</span>`}
      </div>
      <div class="chat-head-actions">
        ${compact ? "" : `<span id="${id("chatSync")}" data-chat-control="sync" class="chat-sync chat-sync--${model.syncState}" aria-live="polite">
          <span class="chat-sync-dot" aria-hidden="true"></span>
          <span data-chat-sync-label>${escapeHtml(chatSyncLabel(model.syncState))}</span>
        </span>
        <span class="chat-provider">${escapeHtml(model.providerLabel)}</span>
        <button id="${id("chatResume")}" type="button" data-open-discussions class="tool-button chat-resume-button" title="Choisir une discussion a reprendre" aria-label="Reprendre une discussion">
          <i data-lucide="messages-square"></i><span>Reprendre une discussion</span>
        </button>
        <button id="${id("chatHistoryToggle")}" data-chat-action="history-toggle" class="tool-button chat-history-button ${model.historyOpen ? "primary" : ""}" title="Afficher les messages envoyes dans ce chat" aria-label="Historique de ce chat" aria-expanded="${model.historyOpen}">
          <i data-lucide="history"></i><span>Historique</span><small>${userMessageCount}</small>
        </button>
         <button id="${id("chatRefresh")}" data-chat-action="refresh" class="icon-button wide" title="Actualiser" aria-label="Actualiser">
           <i data-lucide="refresh-ccw"></i>
         </button>`}
        ${compact && fullscreen ? `<button id="${id("chatHistoryToggle")}" data-chat-action="history-toggle" class="tool-button chat-history-button ${model.historyOpen ? "primary" : ""}" title="Afficher les messages envoyes dans ce chat" aria-label="Historique de ce chat" aria-expanded="${model.historyOpen}">
          <i data-lucide="history"></i><span>Historique</span><small>${userMessageCount}</small>
        </button>` : ""}
        ${compact ? "" : `<button id="${id("chatNew")}" data-chat-action="new" class="tool-button primary chat-new-button" title="Nouvelle conversation">
          <i data-lucide="plus"></i><span>Nouveau chat</span>
        </button>`}
      </div>
    </header>
    <div class="chat-conversation-body">
      <div id="${id("chatFeed")}" data-chat-control="feed" class="chat-feed">${renderChatFeedInner(model, instanceId)}</div>
      ${renderChatHistory(model, instanceId)}
    </div>
    <form id="${id("chatComposer")}" data-chat-control="composer" class="chat-composer ${running ? "is-running" : ""}">
      <div class="chat-composer-box">
        <textarea id="${id("chatPrompt")}" data-chat-control="prompt" rows="1" placeholder="Demandez a ${escapeHtml(model.providerLabel || "l'agent")} de construire quelque chose…" ${running ? "disabled" : ""}>${escapeHtml(model.draft)}</textarea>
        <div class="chat-composer-toolbar">
          <div class="chat-composer-context">
            <label class="chat-mode-select" title="Mode de travail">
              <i data-lucide="sparkles"></i>
              <select id="${id("chatMode")}" data-chat-control="mode" ${running ? "disabled" : ""} aria-label="Mode de travail">
                <option value="build" ${model.mode === "build" ? "selected" : ""}>Construire</option>
                <option value="plan" ${model.mode === "plan" ? "selected" : ""}>Planifier</option>
                <option value="ask" ${model.mode === "ask" ? "selected" : ""}>Question</option>
              </select>
            </label>
            <label class="chat-model-select" title="Modele utilise pour les prochains messages">
              <i data-lucide="cpu"></i>
              <input id="${id("chatModel")}" data-chat-control="model" list="${id("chatModelSuggestions")}" value="${escapeHtml(model.selectedModel)}" ${running || !model.selectedAccountId ? "disabled" : ""} aria-label="Modele" autocomplete="off" spellcheck="false" maxlength="160" />
              <datalist id="${id("chatModelSuggestions")}">${modelSuggestions(model)}</datalist>
            </label>
            <label class="chat-effort-select" title="${model.supportsReasoningEffort ? "Intensite de raisonnement Codex" : "Ce fournisseur ne gere pas l'intensite de raisonnement"}">
              <i data-lucide="gauge"></i>
              <select id="${id("chatReasoningEffort")}" data-chat-control="reasoning-effort" ${running || !model.selectedAccountId || !model.supportsReasoningEffort ? "disabled" : ""} aria-label="Intensite de raisonnement">
                ${reasoningEffortOptions(model)}
              </select>
            </label>
            <span class="chat-workspace-chip" title="${escapeHtml(model.workspaceLabel)}"><i data-lucide="folder-open"></i>${escapeHtml(model.workspaceLabel)}</span>
          </div>
          ${running
            ? `<button id="${id("chatStop")}" data-chat-action="stop" type="button" class="chat-send chat-stop" title="Arreter la reponse" aria-label="Arreter la reponse"><i data-lucide="square"></i></button>`
            : `<button id="${id("chatSend")}" data-chat-action="send" type="submit" class="chat-send" title="Envoyer" aria-label="Envoyer" ${model.accounts.length ? "" : "disabled"}><i data-lucide="send"></i></button>`}
        </div>
      </div>
      <small>Entree pour envoyer · Maj + Entree pour une nouvelle ligne</small>
    </form>
  </section>`;
};
