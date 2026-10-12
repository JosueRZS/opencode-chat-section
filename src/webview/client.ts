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
const outputBtn = document.getElementById("output-btn") as HTMLButtonElement;
const termEl = document.getElementById("terminal") as HTMLDivElement;
// P-025: panel de estado + loader. Sin esto, un fallo de spawn es invisible.
const statusEl = document.getElementById("status") as HTMLDivElement;
const statusText = document.getElementById("status-text") as HTMLSpanElement;
const spinner = document.getElementById("spinner") as HTMLSpanElement;

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
// `term.open()` sobre un contenedor aún oculto puede fallar. Si lo hace, el panel
// de estado lo dirá en rojo: preferimos un error legible a una sección muda.
try {
  term.open(termEl);
} catch (e) {
  setStatus("error", `xterm.js no pudo iniciarse: ${e instanceof Error ? e.message : String(e)}`);
}

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

/**
 * P-025 — Panel de diagnóstico: refleja la fase REAL de la PTY.
 * `starting` muestra el loader; `error` lo pinta en color de error.
 */
const PHASE_LABEL: Record<string, string> = {
  idle: "Listo para lanzar.",
  starting: "Arrancando OpenCode…",
  running: "OpenCode en ejecución.",
  exited: "OpenCode terminó. Vuelve a lanzar cuando quieras.",
  error: "Error:",
};

function setStatus(phase: string, detail: string): void {
  const label = PHASE_LABEL[phase] ?? phase;
  statusText.textContent = detail ? `${label} ${detail}` : label;
  statusEl.dataset.phase = phase;
  spinner.classList.toggle("hidden", phase !== "starting");
  launchBtn.disabled = phase === "starting";
  launchBtn.textContent = phase === "starting" ? "Arrancando…" : "Launch OpenCode Chat";
  // El TUI solo ocupa la sección cuando hay algo real en marcha.
  if (phase !== "running") {
    setState(false);
  }
}

/**
 * P-025 — Watchdog de respuesta: si tras pulsar Launch la extensión no manda
 * ninguna fase en 2 s, el panel lo dice en rojo. Así "arrancando…" nunca se
 * queda girando sin explicación (era justo el síntoma que ocultaba el fallo).
 */
let replyTimer: ReturnType<typeof setTimeout> | undefined;
function expectReply(): void {
  clearTimeout(replyTimer);
  replyTimer = setTimeout(() => {
    setStatus(
      "error",
      "la extensión no contestó en 2 s. Pulsa «salida» para ver el motivo.",
    );
  }, 2000);
}
function gotReply(): void {
  clearTimeout(replyTimer);
}

launchBtn.addEventListener("click", () => {
  // Feedback inmediato: el usuario ve que el clic sí se registró.
  setStatus("starting", "enviando petición de launch…");
  expectReply();
  vscode.postMessage({ type: "launch" });
});

// P-025: la pestaña Salida estándar de VS Code (View → Output → "OpenCode Chat").
outputBtn.addEventListener("click", () => {
  vscode.postMessage({ type: "showOutput" });
});

window.addEventListener("message", (e: MessageEvent) => {
  const msg = e.data as { type: string; data?: string; running?: boolean; phase?: string; detail?: string };
  // Cualquier respuesta de la extensión cancela el watchdog.
  gotReply();
  switch (msg?.type) {
    case "data":
      if (typeof msg.data === "string") {
        term.write(msg.data);
      }
      break;
    case "state":
      setState(msg.running === true);
      break;
    case "status":
      setStatus(msg.phase ?? "idle", msg.detail ?? "");
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
