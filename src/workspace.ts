// Les noms de types et de champs `Workspace*` restent stables pour relire les
// settings et les appels API existants. Dans l'interface, ce concept est un
// « dossier » : un chemin projet qui regroupe conversations et terminaux.
export type WorkspaceProfile = {
  id: string;
  label: string;
  path: string;
};

/**
 * Identite stable d'un dossier projet. Les chemins Windows et UNC sont compares
 * sans tenir compte de la casse, contrairement aux chemins Unix distants.
 */
export const normalizeWorkspacePath = (path: string): string => {
  const normalized = path.trim().replace(/[\\/]+$/, "").replaceAll("\\", "/");
  return /^[a-zA-Z]:\//.test(normalized) || normalized.startsWith("//")
    ? normalized.toLowerCase()
    : normalized;
};

export const workspaceIdForPath = (path: string): string => normalizeWorkspacePath(path);

export const workspaceBaseName = (path: string): string =>
  (path.replace(/[\\/]+$/, "").split(/[\\/]/).pop() || path).replace(/\.git$/i, "");

/**
 * Un terminal ne peut appartenir qu'a un environnement explicitement nomme.
 * Cette fonction centralise la regle (les chaines vides ne sont jamais un
 * dossier implicite) pour que l'UI, la restauration et le transport appliquent
 * exactement la meme contrainte.
 */
export const terminalEnvironmentPath = (
  path: string | null | undefined,
): string | null => path?.trim() || null;

export type WorkspaceBreadcrumb = {
  label: string;
  path: string;
};

/** Construit un fil d'Ariane navigable, borne a la racine exposee. */
export const workspacePathBreadcrumbs = (
  root: string | null | undefined,
  current: string | null | undefined,
): WorkspaceBreadcrumb[] => {
  const currentPath = terminalEnvironmentPath(current);
  if (!currentPath) return [];
  const rootPath = terminalEnvironmentPath(root);
  if (!rootPath) {
    return [{ label: workspaceBaseName(currentPath), path: currentPath }];
  }

  const slashPath = (value: string) =>
    value.replaceAll("\\", "/").replace(/\/+$/, "") || "/";
  const rootSlash = slashPath(rootPath);
  const currentSlash = slashPath(currentPath);
  const windowsPath = /^[a-zA-Z]:\//.test(rootSlash) || rootSlash.startsWith("//");
  const compare = (value: string) => (windowsPath ? value.toLowerCase() : value);
  const rootKey = compare(rootSlash);
  const currentKey = compare(currentSlash);
  if (currentKey !== rootKey && !currentKey.startsWith(`${rootKey}/`)) {
    return [{ label: workspaceBaseName(currentPath), path: currentPath }];
  }

  const separator = currentPath.includes("\\") ? "\\" : "/";
  const rootWithoutTrailingSeparator = rootPath.replace(/[\\/]+$/, "");
  const breadcrumbs: WorkspaceBreadcrumb[] = [
    { label: workspaceBaseName(rootPath), path: rootPath },
  ];
  let accumulated = rootWithoutTrailingSeparator;
  const relative = currentSlash.slice(rootSlash.length).replace(/^\/+/, "");
  relative.split("/").filter(Boolean).forEach((segment) => {
    accumulated = `${accumulated}${separator}${segment}`;
    breadcrumbs.push({ label: segment, path: accumulated });
  });
  return breadcrumbs;
};

/**
 * Les agents sont executes dans un worktree prive dont le chemin peut apparaitre
 * brievement dans un transcript. Ni la racine technique ni ses `repo` ne sont
 * des environnements que l'utilisateur peut selectionner ou memoriser.
 */
export const isEphemeralChatWorkspacePath = (
  path: string | null | undefined,
): boolean => {
  const normalized = path ? normalizeWorkspacePath(path) : "";
  return (
    /(?:^|\/)codex-switch-terminal-server\/(?:agents\/)?workspaces(?:\/|$)/i.test(
      normalized,
    ) ||
    /(?:^|\/)(?:agents\/)?workspaces\/[a-z0-9][a-z0-9-]{0,31}-[0-9a-f]{32}(?:\/repo(?:\/|$)|\/?$)/i.test(
      normalized,
    )
  );
};

/** Chemin d'environnement explicitement choisi, jamais un runtime d'agent. */
export const userEnvironmentPath = (
  path: string | null | undefined,
): string | null => {
  const environment = terminalEnvironmentPath(path);
  return environment && !isEphemeralChatWorkspacePath(environment) ? environment : null;
};

export type FolderLinkedTerminal = {
  folderPath?: string | null;
};

/**
 * L'appartenance se calcule depuis le Dossier logique, jamais depuis le
 * workspace physique propre a l'agent.
 */
export const terminalBelongsToFolder = (
  terminal: FolderLinkedTerminal,
  folderPath: string | null | undefined,
): boolean => {
  const left = terminal.folderPath?.trim();
  const right = folderPath?.trim();
  if (!left || !right) return !left && !right;
  return workspaceIdForPath(left) === workspaceIdForPath(right);
};

export const terminalsForFolder = <T extends FolderLinkedTerminal>(
  terminals: readonly T[],
  folderPath: string | null | undefined,
): T[] => terminals.filter((terminal) => terminalBelongsToFolder(terminal, folderPath));

export type DraftableChatPane = {
  discussion?: { sessionId: string } | null;
};

/**
 * Selectionne, parmi les chats ouverts d'un environnement, ceux qui ne sont pas
 * deja representes par une discussion listee dans la barre laterale : soit un
 * nouveau chat sans premier message (pas encore de discussion), soit un chat
 * dont la discussion n'a pas de dossier resolu cote serveur (ex. worktree
 * ephemere) et qui a donc ete ecarte de la liste persistee. Sans cette union, la
 * grille compte « 1 chat » pendant que la barre laterale affiche « Aucun chat ».
 */
export const draftEnvironmentChatPanes = <T extends DraftableChatPane>(
  environmentPanes: readonly T[],
  listedSessionIds: Iterable<string>,
): T[] => {
  const listed = new Set(listedSessionIds);
  return environmentPanes.filter((pane) => {
    const sessionId = pane.discussion?.sessionId;
    return !sessionId || !listed.has(sessionId);
  });
};

export type MergedWorkspaceProfiles = {
  workspaces: WorkspaceProfile[];
  changed: boolean;
};

export type WorkspaceRegistryUpdate = {
  workspaces: WorkspaceProfile[];
  closedWorkspaceIds: string[];
  changed: boolean;
};

/**
 * Recalcule toujours l'id depuis le chemin puis fusionne les doublons. Garder
 * la premiere occurrence preserve son chemin d'affichage et son libelle, tout
 * en donnant une identite commune aux chats et aux terminaux rattaches.
 */
export const mergeWorkspaceProfiles = (
  profiles: readonly WorkspaceProfile[],
): MergedWorkspaceProfiles => {
  const byId = new Map<string, WorkspaceProfile>();
  let changed = false;

  profiles.forEach((profile) => {
    const path = userEnvironmentPath(profile.path);
    if (!path) {
      changed = true;
      return;
    }

    const id = workspaceIdForPath(path);
    const label = profile.label.trim() || workspaceBaseName(path);
    if (byId.has(id)) {
      changed = true;
      return;
    }

    if (profile.id !== id || profile.label !== label || profile.path !== path) {
      changed = true;
    }
    byId.set(id, { id, label, path });
  });

  return { workspaces: [...byId.values()], changed };
};

/** Normalise et deduplique les tombstones des dossiers fermes. */
export const mergeClosedWorkspaceIds = (ids: readonly string[]): string[] => {
  const seen = new Set<string>();
  const merged: string[] = [];
  ids.forEach((rawId) => {
    const id = workspaceIdForPath(rawId);
    if (!id || isEphemeralChatWorkspacePath(id) || seen.has(id)) return;
    seen.add(id);
    merged.push(id);
  });
  return merged;
};

/**
 * Ouvre (ou rouvre) un dossier : ajoute son profil et retire son tombstone.
 * Le resultat est directement persistable dans AppSettings.
 */
export const openWorkspaceRegistry = (
  profiles: readonly WorkspaceProfile[],
  closedIds: readonly string[],
  path: string,
): WorkspaceRegistryUpdate => {
  const trimmed = userEnvironmentPath(path);
  const id = trimmed ? workspaceIdForPath(trimmed) : "";
  const merged = mergeWorkspaceProfiles(profiles);
  const normalizedClosed = mergeClosedWorkspaceIds(closedIds);
  const workspaces = [...merged.workspaces];
  const hadProfile = workspaces.some((workspace) => workspace.id === id);
  const wasClosed = normalizedClosed.includes(id);

  if (trimmed && !hadProfile) {
    workspaces.push({ id, label: workspaceBaseName(trimmed), path: trimmed });
  }

  return {
    workspaces,
    closedWorkspaceIds: normalizedClosed.filter((closedId) => closedId !== id),
    changed:
      merged.changed ||
      (!!trimmed && (!hadProfile || wasClosed)) ||
      normalizedClosed.length !== closedIds.length ||
      normalizedClosed.some((closedId, index) => closedId !== closedIds[index]),
  };
};

/**
 * Ferme un dossier sans toucher a son contenu : retire son profil et conserve
 * un tombstone pour que les anciennes discussions ne le rouvrent pas seules.
 */
export const closeWorkspaceRegistry = (
  profiles: readonly WorkspaceProfile[],
  closedIds: readonly string[],
  path: string,
): WorkspaceRegistryUpdate => {
  const selectablePath = userEnvironmentPath(path);
  const id = selectablePath ? workspaceIdForPath(selectablePath) : "";
  const merged = mergeWorkspaceProfiles(profiles);
  const normalizedClosed = mergeClosedWorkspaceIds(closedIds);
  const hadProfile = merged.workspaces.some((workspace) => workspace.id === id);
  const wasClosed = normalizedClosed.includes(id);

  return {
    workspaces: merged.workspaces.filter((workspace) => workspace.id !== id),
    closedWorkspaceIds: !id || wasClosed ? normalizedClosed : [...normalizedClosed, id],
    changed:
      merged.changed ||
      hadProfile ||
      (!!id && !wasClosed) ||
      normalizedClosed.length !== closedIds.length ||
      normalizedClosed.some((closedId, index) => closedId !== closedIds[index]),
  };
};
