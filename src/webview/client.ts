import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import "./client.css";

/**
 * Cliente del webview — corre en el navegador del WebviewView (NO en el extension host).
 * Aquí vive el TUI de OpenCode: la extensión le pasa los bytes de la PTY (`node-pty`)
 * y nosotros los pintamos con xterm.js; lo que teclea el usuario vuelve a la PTY.
 */

interface VsCodeApi {
  postMessage(msg: unknown): void;
  getState(): unknown;
  setState(state: unknown): void;
}

declare function acquireVsCodeApi(): VsCodeApi;

const vscode = acquireVsCodeApi();

const launchEl = document.getElementById("launch") as HTMLDivElement;
const launchBtn = document.getElementById("launch-btn") as HTMLButtonElement;
const termEl = document.getElementById("terminal") as HTMLDivElement;

// --- Colores del tema de VS Code (xterm no los hereda solo) ---
function cssVar(name: string, fallback: string): string {
  const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return v || fallback;
}

const term = new Terminal({
  cursorBlink: true,
  cursorStyle: "block",
  convertEol: false,
  scrollback: 5000,
  // El TUI de OpenCode usa terminales potentes; le damos el máximo.
  allowProposedApi: true,
  fontFamily: cssVar("--vscode-editor-font-family", "Consolas, 'Courier New', monospace"),
  fontSize: Number(cssVar("--vscode-editor-font-size", "13")) || 13,
  theme: {
    background: cssVar("--vscode-terminal-background", cssVar("--vscode-editor-background", "#1e1e1e")),
    foreground: cssVar("--vscode-terminal-foreground", cssVar("--vscode-foreground", "#cccccc")),
    cursor: cssVar("--vscode-terminal-cursor-foreground", "#aeafad"),
    selectionBackground: cssVar("--vscode-terminal-selectionBackground", "#264f78"),
  },
});

const fit = new FitAddon();
term.loadAddon(fit);
term.open(termEl);

// Teclado del usuario → PTY.
term.onData(data => {
  vscode.postMessage({ type: "input", data });
});

// Tamaño real → PTY (ConPTY lo necesita para que el TUI reflowee bien).
let resizeTimer: ReturnType<typeof setTimeout> | undefined;
function reportSize(): void {
  try {
    fit.fit();
  } catch {
    /* el contenedor puede estar oculto (0x0) */
  }
  if (term.cols > 0 && term.rows > 0) {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
      vscode.postMessage({ type: "resize", cols: term.cols, rows: term.rows });
    }, 50);
  }
}

const observer = new ResizeObserver(() => reportSize());
observer.observe(termEl);

// --- Estado: alternar entre botón Launch y TUI ---
function setState(running: boolean): void {
  const showTerm = running;
  launchEl.classList.toggle("hidden", showTerm);
  termEl.classList.toggle("hidden", !showTerm);
  if (showTerm) {
    reportSize();
    term.focus();
  }
}

launchBtn.addEventListener("click", () => {
  vscode.postMessage({ type: "launch" });
});

window.addEventListener("message", (e: MessageEvent) => {
  const msg = e.data as { type: string; data?: string; running?: boolean };
  switch (msg?.type) {
    case "data":
      if (typeof msg.data === "string") {
        term.write(msg.data);
      }
      break;
    case "state":
      setState(msg.running === true);
      break;
  }
});

// Ctrl/Cmd+Shift+C y Ctrl/Cmd+Shift+V: copiar/pegar cómodos en la sección.
term.attachCustomKeyEventHandler(e => {
  if (!e.ctrlKey && !e.metaKey) {
    return true;
  }
  if (e.shiftKey && e.key.toLowerCase() === "c") {
    const sel = term.getSelection();
    if (sel) {
      void navigator.clipboard.writeText(sel);
    }
    return false;
  }
  if (e.shiftKey && e.key.toLowerCase() === "v") {
    void navigator.clipboard.readText().then(t => {
      if (t) {
        term.paste(t);
      }
    });
    return false;
  }
  return true;
});

// Avisar a la extensión de que ya podemos pintar (y repintar si hay TUI vivo).
vscode.postMessage({ type: "ready" });
