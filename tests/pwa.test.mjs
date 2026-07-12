import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import test from "node:test";

const rootFile = (path) => new URL(`../${path}`, import.meta.url);
const read = (path) => readFile(rootFile(path), "utf8");

test("le manifeste de la web app est installable et possede ses icones", async () => {
  const manifest = JSON.parse(await read("public/manifest.webmanifest"));

  assert.equal(manifest.display, "standalone");
  assert.equal(manifest.start_url, "/");
  assert.equal(manifest.scope, "/");
  assert.equal(manifest.theme_color, "#000000");
  assert.ok(manifest.icons.some((icon) => icon.sizes === "192x192"));
  assert.ok(manifest.icons.some((icon) => icon.sizes === "512x512"));

  await Promise.all([
    access(rootFile("public/apple-touch-icon.png")),
    ...manifest.icons.map((icon) => access(rootFile(`public${icon.src}`))),
  ]);
});

test("la page declare le manifeste et l'icone Apple", async () => {
  const html = await read("index.html");
  assert.match(html, /rel="manifest" href="\/manifest\.webmanifest"/);
  assert.match(html, /rel="apple-touch-icon"[^>]+href="\/apple-touch-icon\.png"/);
  assert.match(html, /apple-mobile-web-app-capable/);
  assert.match(html, /viewport-fit=cover/);
});

test("le service worker ne met jamais les API privees en cache", async () => {
  const worker = await read("public/service-worker.js");
  assert.match(worker, /url\.origin !== self\.location\.origin/);
  assert.match(worker, /url\.pathname\.startsWith\("\/api\/"\)/);
  assert.match(worker, /url\.pathname\.startsWith\("\/ws\/"\)/);
  assert.match(worker, /request\.mode === "navigate"/);
  assert.match(worker, /caches\.match\("\/offline\.html"\)/);
});

test("l'aide Safari reconnait aussi le user-agent iPad de bureau", async () => {
  const source = await read("src/pwa.ts");
  assert.match(source, /Macintosh/);
  assert.match(source, /navigator\.maxTouchPoints > 1/);
  assert.match(source, /display-mode: standalone/);
  assert.match(source, /CstIOS \|\| nativeWindow\.CstAndroid/);
  assert.match(source, /window\.location\.protocol === "https:"/);
  assert.match(source, /serviceWorker\.register\("\/service-worker\.js"/);
});

test("le workflow iOS utilise un Mac distant et publie le build simulateur", async () => {
  const workflow = await read(".github/workflows/ios.yml");
  assert.match(workflow, /workflow_dispatch:/);
  assert.match(workflow, /runs-on: macos-15/);
  assert.match(workflow, /bash scripts\/build-ios\.sh simulator/);
  assert.match(workflow, /actions\/upload-artifact@v4/);
  assert.match(workflow, /CodexTerminal-iOS-Simulator/);
});
