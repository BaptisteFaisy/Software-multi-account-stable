const IOS_INSTALL_HINT_DISMISSED = "codex-switch-terminal.ios-install-hint-dismissed";

type NativeBridgeWindow = Window & {
  CstAndroid?: unknown;
  CstIOS?: unknown;
};

type StandaloneNavigator = Navigator & {
  standalone?: boolean;
};

const isAppleTouchDevice = () => {
  const userAgent = navigator.userAgent;
  return /iPad|iPhone|iPod/i.test(userAgent)
    || (/Macintosh/i.test(userAgent) && navigator.maxTouchPoints > 1);
};

const isInstalledWebApp = () =>
  (navigator as StandaloneNavigator).standalone === true
  || window.matchMedia("(display-mode: standalone)").matches;

const hasNativeMobileBridge = () => {
  const nativeWindow = window as NativeBridgeWindow;
  return Boolean(nativeWindow.CstIOS || nativeWindow.CstAndroid)
    || /CodexTerminaliOS/i.test(navigator.userAgent);
};

const wasInstallHintDismissed = () => {
  try {
    return localStorage.getItem(IOS_INSTALL_HINT_DISMISSED) === "1";
  } catch {
    return false;
  }
};

const dismissInstallHint = (hint: HTMLElement) => {
  hint.remove();
  try {
    localStorage.setItem(IOS_INSTALL_HINT_DISMISSED, "1");
  } catch {
    // Le mode prive peut refuser localStorage ; fermer la bannière suffit.
  }
};

const showIosInstallHint = () => {
  if (
    !isAppleTouchDevice()
    || isInstalledWebApp()
    || hasNativeMobileBridge()
    || wasInstallHintDismissed()
    || document.querySelector(".ios-install-hint")
  ) {
    return;
  }

  const hint = document.createElement("aside");
  hint.className = "ios-install-hint";
  hint.setAttribute("role", "dialog");
  hint.setAttribute("aria-label", "Installer Codex Terminal sur cet iPad");
  hint.innerHTML = `
    <div>
      <strong>Installer Codex Terminal</strong>
      <p>Dans Safari, touche <b>Partager</b>, puis <b>Sur l'ecran d'accueil</b> et active <b>Ouvrir comme app web</b>.</p>
    </div>
    <button type="button" aria-label="Fermer le conseil d'installation">&times;</button>
  `;
  hint.querySelector("button")?.addEventListener("click", () => dismissInstallHint(hint));
  document.body.appendChild(hint);
};

const registerServiceWorker = () => {
  const isWebOrigin = window.location.protocol === "https:" || window.location.protocol === "http:";
  if (
    !("serviceWorker" in navigator)
    || !isWebOrigin
    || !window.isSecureContext
    || hasNativeMobileBridge()
  ) {
    return;
  }
  void navigator.serviceWorker.register("/service-worker.js", {
    scope: "/",
    updateViaCache: "none",
  })
    .then((registration) => registration.update())
    .catch(() => {
      // Le serveur reste utilisable si Safari refuse le service worker.
    });
};

export const initPwaSupport = () => {
  showIosInstallHint();
  if (document.readyState === "complete") {
    registerServiceWorker();
  } else {
    window.addEventListener("load", registerServiceWorker, { once: true });
  }
};
