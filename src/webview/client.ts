import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebglAddon } from "@xterm/addon-webgl";
import type { TerminalStyle } from "../shared/terminalStyle";
import "@xterm/xterm/css/xterm.css";
import "./client.css";

/**
 * Cliente del webview — corre en el navegador del WebviewView (NO en el extension host).
 * Aquí vive el TUI de OpenCode: la extensión le pasa los bytes de la PTY (`node-pty`)
 * y nosotros los pintamos con xterm.js; lo que teclea el usuario vuelve a la PTY.
 *
 * P-029 — renderizado igual que la terminal auténtica de VS Code:
 *  1. **renderizador WebGL** (el mismo que usa VS Code; el DOM por celda deja el
 *     banner ASCII borroso y comprimido);
 *  2. **paleta ANSI de 16 colores** leída de las variables del tema — sin ella,
 *     xterm usa su propia paleta por defecto y los colores del TUI no coinciden;
 *  3. **tipografía de terminal** (`terminal.integrated.*`), enviada por la
 *     extensión porque la fuente no es un color y VS Code no la expone por CSS.
 */

interface VsCodeApi {
  postMessage(msg: unknown): void;
  getState(): unknown;
  setState(state: unknown): void;
}

declare function acquireVsCodeApi(): VsCodeApi;

const vscode = acquireVsCodeApi();

const outputBtn = document.getElementById("output-btn") as HTMLButtonElement;
const termEl = document.getElementById("terminal") as HTMLDivElement;
// P-025: panel de estado + loader. Sin esto, un fallo de spawn es invisible.
const statusEl = document.getElementById("status") as HTMLDivElement;
const statusText = document.getElementById("status-text") as HTMLSpanElement;
const spinner = document.getElementById("spinner") as HTMLSpanElement;
// P-033: el botón Launch que la sección muestra al terminar la sesión.
const launchPanel = document.getElementById("launch-panel") as HTMLDivElement;
const launchBtn = document.getElementById("launch-btn") as HTMLButtonElement;
// P-044: la pregunta de instalación, dentro de la sección y no en un diálogo.
const installPanel = document.getElementById("install-panel") as HTMLDivElement;
const installMsg = document.getElementById("install-msg") as HTMLDivElement;
const installCmd = document.getElementById("install-cmd") as HTMLElement;
const installYes = document.getElementById("install-yes") as HTMLButtonElement;
const installNo = document.getElementById("install-no") as HTMLButtonElement;

// --- Colores del tema de VS Code (xterm no los hereda solo) ---
function cssVar(name: string, fallback: string): string {
  const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return v || fallback;
}

/**
 * Los 16 colores del tema. VS Code los registra como `terminal.ansiBlack` …
 * `terminal.ansiBrightWhite` y **sí** los expone a los webviews como variables CSS
 * (`--vscode-terminal-ansiBlack`, …). Los fallback son la paleta por defecto de
 * xterm.js, por si la variable no estuviera disponible.
 */
const ANSI_FALLBACK = {
  black: "#000000",
  red: "#cd3131",
  green: "#0dbc79",
  yellow: "#e5e510",
  blue: "#2472c8",
  magenta: "#bc3fbc",
  cyan: "#11a8cd",
  white: "#e5e5e5",
  brightBlack: "#666666",
  brightRed: "#f14c4c",
  brightGreen: "#23d18b",
  brightYellow: "#f5f543",
  brightBlue: "#3b8eea",
  brightMagenta: "#d670d6",
  brightCyan: "#29b8db",
  brightWhite: "#ffffff",
};

type AnsiName = keyof typeof ANSI_FALLBACK;

function ansi(name: AnsiName): string {
  // El id de color es `terminal.ansiBrightBlack` ⇒ la variable conserva la
  // capitalización: --vscode-terminal-ansiBrightBlack.
  const cap = name.charAt(0).toUpperCase() + name.slice(1);
  return cssVar(`--vscode-terminal-ansi${cap}`, ANSI_FALLBACK[name]);
}

const term = new Terminal({
  cursorBlink: true,
  cursorStyle: "block",
  convertEol: false,
  // El TUI de OpenCode usa terminales potentes; le damos el máximo.
  allowProposedApi: true,
  // Familia provisional hasta que llegue el estilo real de `terminal.integrated`
  // (mensaje "config"); se usa la del editor solo como arranque visual inmediato.
  fontFamily: cssVar("--vscode-editor-font-family", "Consolas, 'Courier New', monospace"),
  fontSize: Number(cssVar("--vscode-editor-font-size", "14")) || 14,
  theme: {
    background: cssVar("--vscode-terminal-background", cssVar("--vscode-editor-background", "#1e1e1e")),
    foreground: cssVar("--vscode-terminal-foreground", cssVar("--vscode-foreground", "#cccccc")),
    // El id real es `terminalCursor.foreground` ⇒ --vscode-terminalCursor-foreground.
    cursor: cssVar("--vscode-terminalCursor-foreground", "#aeafad"),
    cursorAccent: cssVar("--vscode-terminalCursor-background", "#1e1e1e"),
    selectionBackground: cssVar("--vscode-terminal-selectionBackground", "#264f78"),
    selectionForeground: cssVar("--vscode-terminal-selectionForeground", "#ffffff"),
    black: ansi("black"),
    red: ansi("red"),
    green: ansi("green"),
    yellow: ansi("yellow"),
    blue: ansi("blue"),
    magenta: ansi("magenta"),
    cyan: ansi("cyan"),
    white: ansi("white"),
    brightBlack: ansi("brightBlack"),
    brightRed: ansi("brightRed"),
    brightGreen: ansi("brightGreen"),
    brightYellow: ansi("brightYellow"),
    brightBlue: ansi("brightBlue"),
    brightMagenta: ansi("brightMagenta"),
    brightCyan: ansi("brightCyan"),
    brightWhite: ansi("brightWhite"),
  },
});

const fit = new FitAddon();
term.loadAddon(fit);
// `term.open()` sobre un contenedor aún oculto puede fallar. Si lo hace, el panel
// de estado lo dirá en rojo: preferimos un error legible a una sección muda.
try {
  term.open(termEl);
} catch (e) {
  setStatus(
    "error",
    `xterm.js failed to start: ${e instanceof Error ? e.message : String(e)}`,
    "",
  );
}

// --- Renderizador WebGL (P-029) ---
// VS Code pinta su terminal con WebGL. xterm, por defecto, usa el DOM (una celda
// = un elemento, con su antialiasing): es lo que hacía que el banner ASCII saliera
// "comprimido". WebGL es el mismo camino que VS Code ⇒ idéntico aspecto.
// Se carga DESPUÉS de `open()` y con tamaño > 0; si falla (GPU bloqueada en el
// webview), se sigue con el DOM sin romper nada.
let webglOn = false;
function enableWebgl(): void {
  if (webglOn || term.cols <= 0 || term.rows <= 0) {
    return;
  }
  try {
    const addon = new WebglAddon();
    // Si el contexto se pierde (cambios de GPU, ahorro de energía), se descarta
    // el addon y xterm sigue con el DOM.
    addon.onContextLoss(() => {
      addon.dispose();
      webglOn = false;
      reportRenderer();
    });
    term.loadAddon(addon);
    webglOn = true;
  } catch {
    webglOn = false;
  }
  reportRenderer();
}

/**
 * Diagnóstico (P-029): decirle a la extensión qué renderizador quedó activo.
 * WebGL puede no estar disponible en un webview (GPU bloqueada/sandbox); si es
 * así, la sección sigue siendo correcta pero con el renderizado DOM, y conviene
 * poder verlo en View → Output en lugar de suponerlo.
 */
function reportRenderer(): void {
  vscode.postMessage({ type: "renderer", webgl: webglOn });
}

/**
 * `terminal.integrated.fontWeight` es un `string` libre, pero xterm solo admite
 * una unión cerrada. Se valida en vez de castear a ciegas.
 */
type XtermFontWeight = NonNullable<Terminal["options"]["fontWeight"]>;
const FONT_WEIGHTS = ["normal", "bold", "100", "200", "300", "400", "500", "600", "700", "800", "900"];
function toFontWeight(value: string): XtermFontWeight {
  return (FONT_WEIGHTS as string[]).includes(value) ? (value as XtermFontWeight) : "normal";
}

/**
 * Aplica la tipografía real de la terminal de VS Code (mensaje "config").
 * Al cambiar el tamaño de fuente cambian cols/rows ⇒ rehacer el fit y avisar a la PTY.
 */
function applyStyle(style: TerminalStyle): void {
  term.options.fontFamily = style.fontFamily;
  term.options.fontSize = style.fontSize;
  term.options.lineHeight = style.lineHeight;
  term.options.letterSpacing = style.letterSpacing;
  term.options.fontWeight = toFontWeight(style.fontWeight);
  term.options.fontWeightBold = toFontWeight(style.fontWeightBold);
  term.options.cursorBlink = style.cursorBlink;
  // VS Code llama `line` a lo que xterm llama `bar`.
  term.options.cursorStyle = style.cursorStyle === "line" ? "bar" : style.cursorStyle;
  term.options.scrollback = style.scrollback;
  reportSize();
  enableWebgl();
}

// Teclado del usuario → PTY.
term.onData(data => {
  vscode.postMessage({ type: "input", data });
});

// Tamaño real → PTY (ConPTY lo necesita para que el TUI reflowee bien).
let resizeTimer: ReturnType<typeof setTimeout> | undefined;
/** Último tamaño ya mandado; sirve para no repetir y para no medir a ciegas. */
let sentCols = -1;
let sentRows = -1;
/**
 * Oculta la sección, el contenedor está colapsado y `fit` propondría 1 fila.
 * Mandarla es lo que aplasta el TUI: ConPTY se la cree y redibuja todo en una
 * línea, y al volver a mostrarse la sección sólo queda un rótulo arriba y
 * negro debajo. Mientras la sección esté fuera de vista no se mide nada.
 */
let sectionVisible = true;

function reportSize(): void {
  if (!sectionVisible) {
    return;
  }
  try {
    fit.fit();
  } catch {
    /* el contenedor puede estar oculto (0x0) */
  }
  // Con tamaño real ya se puede cargar WebGL (necesita dims > 0).
  enableWebgl();
  if (term.cols <= 0 || term.rows <= 0) {
    return;
  }
  // Igual que la última vez: no hay nada que comunicar. Hace que los refits de
  // redimensión barata sean inocuos, y evita ruido en ConPTY.
  if (term.cols === sentCols && term.rows === sentRows) {
    return;
  }
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => {
    sentCols = term.cols;
    sentRows = term.rows;
    vscode.postMessage({ type: "resize", cols: sentCols, rows: sentRows });
  }, 50);
}

const observer = new ResizeObserver(() => reportSize());
observer.observe(termEl);
// La barra puede reasentarse sin que `termEl` cambie de tamaño observable.
window.addEventListener("resize", () => reportSize());

// --- Estado de la sesión ---
// P-028: la sección ES la terminal. El TUI está siempre visible; solo cambian
// el ajuste de tamaño, el foco y la barra de estado (que solo aparece en error).
function setState(running: boolean): void {
  if (running) {
    reportSize();
    term.focus();
  }
}

/**
 * P-025/P-028 — Diagnóstico. La barra está **oculta por defecto**: el usuario
 * pidió una sección que sea la terminal, sin chrome.
 *
 * Se muestra en tres casos, todos transitorios:
 *  - `error`: cuando algo va mal de verdad.
 *  - `checking` / `installing`: la guardia de instalación (P-031), que es
 *    exactamente el "paso a paso" que pidió el usuario — comprobar → ofrecer
 *    instalar → instalar → arrancar. Sin esto, la sección estaría muda
 *    durante minutos mientras npm instala.
 *  - `starting` solo lleva spinner, sin texto, para no meter chrome (P-028).
 */
// Las etiquetas llegan YA traducidas del host: el webview no tiene acceso a
// `vscode.l10n` (es contexto de navegador), así que no puede resolverlas aquí.

/**
 * Fases donde la sección está en silencio: solo terminal (P-028).
 *
 * `install-pending` y `awaiting-launch` van aquí porque las dos tienen su
 * propio panel — la pregunta y el botón Launch (P-044): meter además la barra
 * de estado sería duplicar el mensaje.
 */
const SILENT_PHASES = new Set([
  "idle",
  "starting",
  "running",
  "exited",
  "install-pending",
  "awaiting-launch",
]);

function setStatus(phase: string, detail: string, label: string): void {
  statusText.textContent = detail ? `${label} ${detail}` : label;
  statusEl.dataset.phase = phase;
  statusEl.classList.toggle("hidden", SILENT_PHASES.has(phase));
  spinner.classList.toggle("hidden", phase !== "starting" && phase !== "installing");
}

// P-025: la pestaña Salida estándar de VS Code (View → Output → "OpenCode Chat").
outputBtn.addEventListener("click", () => {
  vscode.postMessage({ type: "showOutput" });
});

/**
 * P-033 — El botón Launch.
 *
 * La sección vuelve a él tras cada salida visible de la sesión (`/exit` desde
 * el TUI, o al salir/borrarla), en lugar de relanzarse sola ni quedarse muda.
 * Mientras está visible, la terminal queda debajo: la sesión ya terminó, así
 * que no hay nada que escribir en ella.
 */
function setLaunchPanel(visible: boolean): void {
  launchPanel.classList.toggle("hidden", !visible);
  // La terminal solo tiene sentido con una sesión viva.
  termEl.classList.toggle("session-over", visible);
  if (visible) {
    launchBtn.focus();
  }
}

launchBtn.addEventListener("click", () => {
  vscode.postMessage({ type: "launch" });
});

/**
 * P-044 — El panel de instalación.
 *
 * Mientras está a la vista, la terminal queda debajo igual que con el panel de
 * Launch: no hay sesión que leer todavía, y apilarlo solo añadiría ruido.
 * La respuesta sale como mensaje y la extensión decide; el panel no se oculta
 * aquí para que el estado viva en un solo sitio.
 */
function setInstallPanel(visible: boolean, message: string, command: string): void {
  installPanel.classList.toggle("hidden", !visible);
  termEl.classList.toggle("session-over", visible);
  if (visible) {
    // No los dos a la vez: si el usuario pulsó Launch tras una sesión, el panel
    // de Launch seguía a la vista. La pregunta lo sustituye; la respuesta
    // volverá a decidir qué se muestra.
    launchPanel.classList.add("hidden");
    installMsg.textContent = message;
    // El comando es texto literal del host: NO se usa innerHTML. Es una línea
    // de shell que construye la extensión, y pasarla por HTML sería una vía
    // de inyección gratuita hacia el propio webview.
    installCmd.textContent = command;
    installYes.focus();
  }
}

installYes.addEventListener("click", () => {
  vscode.postMessage({ type: "installAnswer", yes: true });
});
installNo.addEventListener("click", () => {
  vscode.postMessage({ type: "installAnswer", yes: false });
});

window.addEventListener("message", (e: MessageEvent) => {
  const msg = e.data as {
    type: string;
    data?: string;
    running?: boolean;
    phase?: string;
    detail?: string;
    label?: string;
    visible?: boolean;
    style?: TerminalStyle;
    message?: string;
    command?: string;
  };
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
      setStatus(msg.phase ?? "idle", msg.detail ?? "", msg.label ?? "");
      break;
    case "launchButton":
      setLaunchPanel(msg.visible === true);
      break;
    case "installOffer":
      setInstallPanel(msg.visible === true, msg.message ?? "", msg.command ?? "");
      break;
    case "config":
      if (msg.style) {
        applyStyle(msg.style);
      }
      break;
    case "visibility":
      // Mientras la sección esté colapsada no se mide: ver `sectionVisible`.
      sectionVisible = msg.visible === true;
      break;
    case "refit":
      // El host avisa de que la barra acaba de reabrirse. El ResizeObserver no
      // siempre dispara al volver (VS Code colapsa el contenedor sin que
      // `termEl` cambie de tamaño observable), así que la re-medida queda en
      // manos de este aviso, no de la suerte.
      reportSize();
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
