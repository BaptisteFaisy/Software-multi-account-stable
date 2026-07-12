import assert from "node:assert/strict";
import test from "node:test";

import {
  closeWorkspaceRegistry,
  isEphemeralChatWorkspacePath,
  mergeWorkspaceProfiles,
  normalizeWorkspacePath,
  openWorkspaceRegistry,
  terminalEnvironmentPath,
  terminalsForFolder,
  userEnvironmentPath,
  workspacePathBreadcrumbs,
} from "../src/workspace.ts";

test("les variantes d'un meme chemin Windows ont la meme identite", () => {
  assert.equal(
    normalizeWorkspacePath(" C:\\Projects\\Codex-Switch-Terminal\\ "),
    "c:/projects/codex-switch-terminal",
  );
  assert.equal(
    normalizeWorkspacePath("c:/projects/codex-switch-terminal"),
    "c:/projects/codex-switch-terminal",
  );
});

test("les dossiers identiques fusionnent meme si leurs anciens ids different", () => {
  const merged = mergeWorkspaceProfiles([
    {
      id: "ancien-id-local",
      label: "Codex Switch Terminal",
      path: "C:\\Projects\\Codex-Switch-Terminal\\",
    },
    {
      id: "ancien-id-distant",
      label: "Doublon",
      path: "c:/projects/codex-switch-terminal",
    },
  ]);

  assert.equal(merged.changed, true);
  assert.deepEqual(merged.workspaces, [
    {
      id: "c:/projects/codex-switch-terminal",
      label: "Codex Switch Terminal",
      path: "C:\\Projects\\Codex-Switch-Terminal\\",
    },
  ]);
});

test("deux chemins Unix dont seule la casse differe restent distincts", () => {
  const merged = mergeWorkspaceProfiles([
    { id: "x", label: "app", path: "/srv/App" },
    { id: "y", label: "app", path: "/srv/app" },
  ]);

  assert.equal(merged.workspaces.length, 2);
});

test("fermer un dossier le retire du registre sans perdre son identite", () => {
  const closed = closeWorkspaceRegistry(
    [{ id: "ancien", label: "Projet", path: "C:\\Projects\\Projet" }],
    [],
    "c:/projects/projet/",
  );

  assert.equal(closed.changed, true);
  assert.deepEqual(closed.workspaces, []);
  assert.deepEqual(closed.closedWorkspaceIds, ["c:/projects/projet"]);
});

test("rouvrir un dossier retire son tombstone et restaure son profil", () => {
  const opened = openWorkspaceRegistry(
    [],
    [" C:\\Projects\\Projet\\ ", "c:/projects/projet"],
    "C:\\Projects\\Projet",
  );

  assert.equal(opened.changed, true);
  assert.deepEqual(opened.closedWorkspaceIds, []);
  assert.deepEqual(opened.workspaces, [
    {
      id: "c:/projects/projet",
      label: "Projet",
      path: "C:\\Projects\\Projet",
    },
  ]);
});

test("un dossier regroupe plusieurs agents sans fusionner leurs workspaces", () => {
  const terminals = [
    {
      key: "terminal-codex",
      agentId: "codex",
      folderPath: "C:\\Projects\\Produit",
      workspaceId: "ws-codex",
      workspacePath: "C:\\runtime\\workspaces\\ws-codex\\repo",
    },
    {
      key: "terminal-claude",
      agentId: "claude",
      folderPath: "c:/projects/produit/",
      workspaceId: "ws-claude",
      workspacePath: "C:\\runtime\\workspaces\\ws-claude\\repo",
    },
    {
      key: "terminal-autre",
      agentId: "codex",
      folderPath: "C:\\Projects\\Autre",
      workspaceId: "ws-autre",
      workspacePath: "C:\\runtime\\workspaces\\ws-autre\\repo",
    },
  ];

  const associated = terminalsForFolder(terminals, "c:/projects/produit");
  assert.deepEqual(associated.map((terminal) => terminal.key), [
    "terminal-codex",
    "terminal-claude",
  ]);
  assert.equal(new Set(associated.map((terminal) => terminal.workspaceId)).size, 2);
});

test("un environnement de terminal doit contenir un dossier explicite", () => {
  assert.equal(terminalEnvironmentPath(undefined), null);
  assert.equal(terminalEnvironmentPath("   "), null);
  assert.equal(
    terminalEnvironmentPath("  C:\\Projects\\Produit  "),
    "C:\\Projects\\Produit",
  );
});

test("le navigateur construit un fil d'Ariane Windows borne a sa racine", () => {
  assert.deepEqual(
    workspacePathBreadcrumbs(
      "C:\\Users\\jeanp",
      "C:\\Users\\jeanp\\codex-switch-terminal\\src",
    ),
    [
      { label: "jeanp", path: "C:\\Users\\jeanp" },
      { label: "codex-switch-terminal", path: "C:\\Users\\jeanp\\codex-switch-terminal" },
      { label: "src", path: "C:\\Users\\jeanp\\codex-switch-terminal\\src" },
    ],
  );
});

test("le navigateur construit aussi un fil d'Ariane Unix", () => {
  assert.deepEqual(workspacePathBreadcrumbs("/srv", "/srv/apps/demo"), [
    { label: "srv", path: "/srv" },
    { label: "apps", path: "/srv/apps" },
    { label: "demo", path: "/srv/apps/demo" },
  ]);
});

test("un worktree de chat ephemere n'est jamais pris pour un environnement", () => {
  assert.equal(
    isEphemeralChatWorkspacePath(
      "C:\\runtime\\agents\\workspaces\\desktop-chat-3-828787c2865f45cbb99d51a3e127811e\\repo",
    ),
    true,
  );
  assert.equal(
    isEphemeralChatWorkspacePath(
      "/srv/runtime/workspaces/desktop-chat-12-828787c2865f45cbb99d51a3e127811e/repo/packages/app",
    ),
    true,
  );
  assert.equal(
    isEphemeralChatWorkspacePath(
      "C:\\runtime\\workspaces\\1783872478683-9a0beba066544160bd50b41bd3864737\\repo",
    ),
    true,
  );
  assert.equal(
    isEphemeralChatWorkspacePath(
      "C:\\runtime\\agents\\workspaces\\codex-e28ffd81abb14bd7ba7e53fd742e7bcb\\repo",
    ),
    true,
  );
  assert.equal(
    isEphemeralChatWorkspacePath(
      "C:\\Users\\jeanp\\AppData\\Roaming\\codex-switch-terminal-server\\workspaces",
    ),
    true,
  );
  assert.equal(
    isEphemeralChatWorkspacePath("C:\\Users\\jeanp\\codex-switch-terminal"),
    false,
  );
  assert.equal(
    userEnvironmentPath(
      "C:\\Users\\jeanp\\AppData\\Roaming\\codex-switch-terminal-server\\agents\\workspaces\\desktop-chat-2-1b6f99e95df64caab03c31a1907aaae5\\repo",
    ),
    null,
  );
});

test("le registre supprime les anciens environnements techniques", () => {
  const technical =
    "C:\\Users\\jeanp\\AppData\\Roaming\\codex-switch-terminal-server\\workspaces\\1783851915932-1784c9e325794eea96db0bdfa0c22928\\repo";
  const project = "C:\\Users\\jeanp\\codex-switch-terminal";
  const merged = mergeWorkspaceProfiles([
    { id: technical.toLowerCase(), label: "repo", path: technical },
    { id: "ancien", label: "Projet", path: project },
  ]);

  assert.equal(merged.changed, true);
  assert.deepEqual(merged.workspaces, [
    {
      id: "c:/users/jeanp/codex-switch-terminal",
      label: "Projet",
      path: project,
    },
  ]);

  const opened = openWorkspaceRegistry(
    merged.workspaces,
    [technical, "c:/users/jeanp/ferme"],
    technical,
  );
  assert.deepEqual(opened.workspaces, merged.workspaces);
  assert.deepEqual(opened.closedWorkspaceIds, ["c:/users/jeanp/ferme"]);
});
