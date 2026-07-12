import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const main = readFileSync(new URL("../src/main.ts", import.meta.url), "utf8");
const style = readFileSync(new URL("../src/style.css", import.meta.url), "utf8");
const desktop = readFileSync(
  new URL("../src-tauri/src/terminal.rs", import.meta.url),
  "utf8",
);
const server = readFileSync(
  new URL("../src-tauri/src/server.rs", import.meta.url),
  "utf8",
);

test("un menu separe est l'unique selecteur d'environnement", () => {
  for (const marker of [
    "chat-environment-selector",
    "renderTerminalEnvironmentMenu",
    "data-environment-menu-id",
    "selectEnvironment",
    "Choisir un environnement",
  ]) {
    assert.ok(main.includes(marker), `selecteur manquant: ${marker}`);
  }
  assert.doesNotMatch(main, /renderTerminalEnvironmentTabs|data-terminal-environment|Nouvel onglet/);
  assert.doesNotMatch(style, /\.terminal-environment-tab/);
});

test("la touche accent grave ouvre le menu des environnements", () => {
  assert.match(main, /event\.key === "`" \|\| event\.code === "Backquote"/);
  assert.match(main, /event\.code === "Digit7"/);
  assert.match(main, /renderTerminalEnvironmentMenu/);
  assert.match(main, /terminalEnvironmentMenuOpen/);
  assert.match(main, /data-environment-menu-id/);
  assert.match(style, /\.terminal-environment-menu-backdrop/);
});

test("l'environnement actif contient ses propres chats et sa collaboration", () => {
  for (const marker of [
    "expertChatPanesForCurrentEnvironment",
    "expertChatPaneEnvironmentPath",
    "Chats de cet environnement",
    "openEnvironmentCollaboration",
    "Collaboration de l'environnement",
  ]) {
    assert.ok(main.includes(marker), `contexte d'environnement incomplet: ${marker}`);
  }
  assert.match(main, /workspaceIdForPath\(panePath\) === environmentId/);
  assert.match(main, /discussion\.folderPath = capturedWorkspace/);
  assert.match(main, /isEphemeralChatWorkspacePath\(discussion\.cwd\)/);
});

test("un nouveau chat peut etre ouvert avec l'agent choisi", () => {
  assert.match(main, /id="newChatAgent"/);
  assert.match(main, /Agent du nouveau chat/);
  assert.match(main, /addExpertChatPane\(agentId\)/);
  assert.match(main, /accountId: accountId \?\?/);
});

test("le choix d'environnement propose un explorateur de dossiers navigable", () => {
  for (const marker of [
    "Parcourir les dossiers",
    "workspacePathBreadcrumbs",
    "workspaceFolderSearch",
    "ws-quick-access",
    "data-ws-dir",
    "Choisir ce dossier",
  ]) {
    assert.ok(main.includes(marker), `explorateur incomplet: ${marker}`);
  }
  assert.match(style, /\.workspace-browser-modal/);
  assert.match(style, /\.ws-breadcrumb/);
  assert.match(style, /\.ws-folder-toolbar/);
});

test("les workspaces temporaires des agents ne deviennent jamais des environnements", () => {
  assert.match(main, /userEnvironmentPath\(stored\)/);
  assert.match(main, /userEnvironmentPath\(discussion\?\.folderPath\)/);
  assert.match(main, /!isEphemeralChatWorkspacePath\(entry\.path\)/);
  assert.match(main, /workspace technique temporaire et ne peut pas etre ajoute/);
});

test("un environnement peut etre retire depuis son menu sans effacer ses fichiers", () => {
  assert.match(main, /data-delete-environment-id/);
  assert.match(main, /Supprimer l'environnement/);
  assert.match(main, /Le repertoire et ses fichiers resteront sur le disque/);
  assert.match(main, /closeWorkspace\(workspace, true\)/);
  assert.match(main, /!workspaceIsClosed\(path\)/);
  assert.match(style, /\.terminal-environment-menu-delete/);
});

test("la creation exige un environnement avant tout appel PTY", () => {
  assert.match(main, /const environmentPath = userEnvironmentPath\(folderPath\)/);
  assert.match(main, /Creation bloquee: choisis d'abord un environnement/);
  assert.match(main, /Environnement de ce terminal \/ session \(obligatoire\)/);
  assert.match(main, /aria-required="true"/);
});

test("les backends desktop et serveur refusent un environnement implicite", () => {
  const error = "Environnement obligatoire avant d'ouvrir un terminal";
  assert.ok(desktop.includes(error));
  assert.ok(server.includes(error));
  assert.doesNotMatch(server, /prepare_local\(&agent_id, &canonical_home, None\)/);
});
