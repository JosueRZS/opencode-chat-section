import * as vscode from "vscode";
import * as path from "path";
import type { OpenCodePty } from "../terminal/OpenCodePty";
import type { FileLog } from "../utils/filelog";
import { STATUS_VIEW_ID } from "../utils/placement";
import type { TerminalStyle } from "../shared/terminalStyle";
import { describeTerminalStyle, readTerminalStyle } from "../utils/terminalConfig";
import { stamp } from "../utils/log";

/** Mensajes webview → extensión. */
type InMsg =
  | { type: "ready" }
  | { type: "input"; data: string }
  | { type: "resize"; cols: number; rows: number }
  | { type: "renderer"; webgl: boolean }
  | { type: "launch" }
  | { type: "showOutput" };

/** Mensajes extensión → webview. */
type OutMsg =
  | { type: "data"; data: string }
  | { type: "state"; running: boolean }
  | { type: "status"; phase: string; detail: string; label: string }
  | { type: "config"; style: TerminalStyle }
  | { type: "launchButton"; visible: boolean };

/**
 * Etiqueta de cada fase, ya en el idioma del editor.
 *
 * El webview es contexto de navegador: ahí `vscode.l10n` NO existe. Por eso la
 * traducción se resuelve aquí, en el host, y viaja resuelta dentro del mensaje
 * `status`. Es lo mismo que hace el workbench con sus propios webviews.
 */
function phaseLabel(phase: string): string {
  switch (phase) {
    case "error":
      return vscode.l10n.t("Error:");
    case "checking":
      return vscode.l10n.t("Checking OpenCode…");
    case "installing":
      return vscode.l10n.t("Installing OpenCode…");
    default:
      return "";
  }
}

/**
 * §4 (D7) — La sección "OpenCode" DENTRO del contenedor de Chat, pero ahora
 * renderizando el TUI real.
 *
 * P-022: `vscode.window.createTerminal` solo admite Panel o Editor (P-017) — nunca
 * una vista. Así que la sección es un **WebviewView con xterm.js** y la PTY la corre
 * la extensión (`node-pty`): el TUI de OpenCode se dibuja literalmente donde antes
 * estaba el botón Launch.
 *
 * La vista se sigue DECLARANDO con la clave `explorer` (P-019) y moviendo en caliente
 * a Chat, así que toda la colocación de D7 rev.5 sigue intacta.
 */
export class TuiViewProvider implements vscode.WebviewViewProvider, vscode.Disposable {
  static readonly viewType = STATUS_VIEW_ID;

  private view: vscode.WebviewView | undefined;
  private ready = false;
  /** P-025: cuántas veces se ha resuelto la vista (recreación tras moveViews). */
  private resolveCount = 0;
  /** P-025: último estado de la PTY; se reenvía al llegar el `ready` del webview. */
  private lastStatus: { phase: string; detail: string; label: string } = {
    phase: "idle",
    detail: "",
    label: "",
  };
  /** P-033: estado del botón Launch de la sección. */
  private launchButtonVisible = false;
  private readonly subs: vscode.Disposable[] = [];
  /** Suscripciones del webview actual; se descartan si `resolveWebviewView` se repite. */
  private viewSubs: vscode.Disposable[] = [];
  /** P-037: lotes de `input`; ver `traceInputBurst`. */
  private inputCount = 0;
  private inputQuiet: ReturnType<typeof setTimeout> | undefined;
  /** P-041: solo se informa del primer lote de cada webview. */
  private inputReported = false;

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly pty: OpenCodePty,
    private readonly output: vscode.OutputChannel,
    private readonly fileLog: FileLog,
  ) {
    // La PTY escribe → reenviar al webview (si ya está listo).
    this.subs.push(pty.onDidReceiveData(data => {
      this.post({ type: "data", data });
    }));
    // Estado cambia → re-sincronizar con la vista (P-033: sin relanzado
    // automático; la sección vuelve al botón Launch tras cada salida).
    this.subs.push(
      pty.onDidChangeState(() => {
        this.syncState();
      }),
    );
    // P-025: fase real (idle/starting/running/exited/error) → panel + loader.
    this.subs.push(
      pty.onDidChangeStatus(s => {
        this.lastStatus = { ...s, label: phaseLabel(s.phase) };
        this.trace(`[status] ${s.phase} :: ${s.detail}`);
        this.post({
          type: "status",
          phase: s.phase,
          detail: s.detail,
          label: this.lastStatus.label,
        });
        // P-033: al terminar la sesión, la sección vuelve al botón Launch.
        this.setLaunchButton(s.phase === "exited" || s.phase === "error");
        // Como en el resto de extensiones: si algo FALLA, la pestaña Salida se
        // abre sola y el motivo queda a la vista sin tener que buscarlo.
        if (s.phase === "error") {
          this.output.show(true);
        }
      }),
    );
  }

  /** P-025: traza a Salida (público) y al fichero (respaldo síncrono). */
  private trace(msg: string): void {
    this.output.appendLine(`${stamp()} ${msg}`);
    this.fileLog.write(msg);
  }

  /**
   * P-037 — `input` es un mensaje de ALTA FRECUENCIA y no conviene trazarlo uno
   * a uno.
   *
   * `term.onData` no es solo teclado. xterm emite por ahí también los reportes
   * de ratón y de foco cuando el TUI los ha activado, y OpenCode los activa
   * todos. Secuencia de arranque real, capturada de la PTY:
   *
   *   \e[?1000h   ratón: clics
   *   \e[?1002h   ratón: arrastre
   *   \e[?1003h   ratón: CUALQUIER movimiento (botón o no)
   *   \e[?1006h   codificación SGR de lo anterior
   *   \e[?1004h   informe de foco (\e[I / \e[O)
   *   \e[?2004h   pegado entre corchetes
   *
   * Con el 1003, cada pasada del ratón por la sección es un mensaje `input`; con
   * el 1004, cada cambio de foco son dos. `trace` escribe en el canal de Salida
   * Y en el fichero, y ninguno de los dos trunca, así que la traza crecía sin
   * límite mientras el usuario solo pasaba el cursor por encima.
   *
   * Se mantiene la señal de P-025 («¿llega la entrada al canal de mensajes?»)
   * pero **una sola vez por webview**: la pregunta se contesta con el primer
   * lote, y seguir imprimiéndola solo añade ruido — con el 1003 activo, cada
   * pasada del ratón por la sección produce un lote. Al recrearse el webview
   * (`resolveCount`) se vuelve a preguntar, porque esa es precisamente la
   * ocasión en la que el canal podría haberse perdido.
   */
  private traceInputBurst(): void {
    this.inputCount++;
    if (this.inputQuiet) {
      clearTimeout(this.inputQuiet);
    }
    this.inputQuiet = setTimeout(() => {
      const n = this.inputCount;
      this.inputCount = 0;
      this.inputQuiet = undefined;
      if (this.inputReported) {
        return;
      }
      this.inputReported = true;
      this.trace(
        `[view] entrada del TUI confirmada: ${n} mensajes por onData ` +
          `(lote inicial; con el ratón 1003 activo siguen llegando, sin registrarlas)`,
      );
    }, 1000);
  }

  resolveWebviewView(view: vscode.WebviewView): void {
    // P-025: nº de resoluciones. Si es >1, la vista se recreó (moveViews): hay
    // que re-sincronizar estado o el panel se quedaría clavado en "arrancando".
    this.resolveCount++;
    this.trace(
      `[view] resolveWebviewView #${this.resolveCount} (ready previo=${this.ready})`,
    );
    // El canal se vuelve a preguntar en cada webview nuevo (P-041).
    this.inputReported = false;

    // Si la vista se recrea (drag fuera y vuelta, o reload del contenedor),
    // descartar las suscripciones de la anterior para no duplicar mensajes.
    for (const d of this.viewSubs) {
      d.dispose();
    }
    this.viewSubs = [];

    this.view = view;
    this.ready = false;

    view.webview.options = {
      enableScripts: true,
      // Solo los assets propios (dist/webview.js + dist/webview.css).
      localResourceRoots: [vscode.Uri.file(path.join(this.context.extensionPath, "dist"))],
    };

    // El listener se registra ANTES de asignar el HTML, así que ningún mensaje
    // del webview — ni siquiera el `ready` — puede perderse mientras carga.
    this.viewSubs.push(
      view.webview.onDidReceiveMessage((msg: InMsg) => {
        // P-025: traza de TODO lo que entra, en la pestaña Salida. Si el clic
        // del usuario no aparece aquí, el fallo es del canal de mensajes.
        // P-037: `input` va aparte — es el único tipo de alta frecuencia.
        if (msg?.type === "input") {
          this.traceInputBurst();
        } else {
          this.trace(`[view] mensaje recibido: ${msg?.type ?? "(sin type)"}`);
        }
        switch (msg?.type) {
          case "ready": {
            this.ready = true;
            // P-029: la tipografía real de la terminal de VS Code. Va ANTES del
            // replay para que el TUI se pinte ya con las métricas correctas.
            this.sendConfig();
            // Repintar con lo acumulado: con `retainContextWhenHidden` el webview
            // puede reabrirse con la TUI ya corriendo.
            const replay = this.pty.replayBuffer;
            if (replay) {
              this.post({ type: "data", data: replay });
            }
            this.syncState();
            // Reenviar la fase vigente: sin esto, si la vista se recreó mientras
            // el TUI arrancaba, el panel volvería a "arrancando" y ya no remitiría.
            this.post({
              type: "status",
              phase: this.lastStatus.phase,
              detail: this.lastStatus.detail,
              label: this.lastStatus.label,
            });
            // P-033: el botón Launch es estado persistido en la extensión; si el
            // webview se recrea, hay que volver a decirle si debe estar a la vista.
            this.post({ type: "launchButton", visible: this.launchButtonVisible });
            this.trace(`[view] webview listo (replay=${replay.length}B, launch=${this.launchButtonVisible})`);
            break;
          }
          case "renderer":
            // P-029: qué renderizador quedó activo. WebGL puede no estar
            // disponible en un webview; conviene poder verlo, no suponerlo.
            this.trace(
              `[view] renderizador: ${msg.webgl ? "WebGL (igual que la terminal de VS Code)" : "DOM (WebGL no disponible en el webview)"}`,
            );
            break;
          case "showOutput":
            // P-025: lo que pidió el usuario — la Salida estándar de VS Code
            // (View → Output → "OpenCode Chat"), como en cualquier otra extensión.
            this.output.show(true);
            break;
          case "input":
            this.pty.write(msg.data);
            break;
          case "launch":
            // P-033: el botón de la sección. `launch()` corre la guardia de
            // instalación (P-031) antes de arrancar: si falta OpenCode, primero
            // aparece el diálogo de instalar sí/no.
            this.trace("[view] Launch pulsado en la sección");
            this.pty.launch();
            break;
          case "resize":
            this.pty.resize(msg.cols, msg.rows);
            break;
        }
      }),
    );

    view.webview.html = this.buildHtml(view.webview);

    // Al ocultarse/mostrarse la sección, re-enfocar el TUI si está corriendo.
    // Nota: `onDidChangeVisibility` es `Event<void>` — el estado está en `view.visible`.
    this.viewSubs.push(
      view.onDidChangeVisibility(() => {
        if (view.visible && this.pty.isRunning) {
          this.post({ type: "state", running: true });
        }
      }),
    );

    // P-029: si el usuario cambia `terminal.integrated.*` (o de tema), el xterm
    // de la sección se repinta con la nueva tipografía/paleta sin recrearse.
    this.viewSubs.push(
      vscode.workspace.onDidChangeConfiguration(e => {
        if (e.affectsConfiguration("terminal.integrated") || e.affectsConfiguration("workbench.colorCustomizations") || e.affectsConfiguration("workbench.colorTheme")) {
          this.trace("[view] terminal.integrated / tema cambiados → reenviando estilo");
          this.sendConfig();
        }
      }),
    );

    this.trace("[view] webview resuelto");

    // P-028: la sección ES la terminal ⇒ si no hay sesión viva, se arranca sola.
    this.autoLaunchIfIdle();
  }

  /**
   * P-028 → P-033 — Arranca OpenCode la **primera** vez que se abre la sección.
   *
   * P-028 pedía que la sección fuese la terminal y arrancara sola; eso se
   * mantiene. Lo que P-033 cambia es lo que pasa **después** de una salida
   * visible: ya no se relanza sola, y la sección vuelve al botón Launch
   * (decisión del usuario: cada salida, no solo los fallos).
   *
   * Por eso aquí solo se autoarranca si aún no ha habido una sesión que el
   * usuario haya terminado — `launchButtonVisible` es el indicador: en cuanto
   * el TUI salió, la sección queda en manos del botón.
   */
  private autoLaunchIfIdle(): void {
    if (this.pty.isRunning || !this.autoLaunchEnabled()) {
      return;
    }
    if (this.launchButtonVisible) {
      this.trace("[view] hay una sesión terminada ⇒ se espera al botón Launch");
      return;
    }
    this.trace("[view] auto-lanzando OpenCode");
    this.pty.launch();
  }

  private autoLaunchEnabled(): boolean {
    return vscode.workspace.getConfiguration("opencodeChat").get<boolean>("autoLaunch", true);
  }

  /** §5.1: enfocar el TUI dentro de la sección. */
  focus(): void {
    void vscode.commands.executeCommand(`${STATUS_VIEW_ID}.focus`);
  }

  /**
   * P-033 — Muestra/oculta el botón Launch de la sección.
   *
   * El usuario pidió que, tras cada salida visible de la sesión (`/exit` desde
   * el TUI, o al salir/borrarla), la sección **vuelva al botón Launch** en vez
   * de relanzarse sola ni quedarse muda. La señal que dispara esto no es texto
   * — la heurística de prompt se armaba a los 1,5 s del arranque y abortaba
   * la sesión — sino `ESC[?1049l`, que el TUI emite al restaurar la pantalla.
   *
   * `autoLaunchIfIdle()` sigue autoarrancando la **primera** vez que se abre
   * la sección (P-028); lo que ya no hace es relanzar tras una salida.
   */
  private setLaunchButton(visible: boolean): void {
    if (this.launchButtonVisible === visible) {
      return;
    }
    this.launchButtonVisible = visible;
    this.post({ type: "launchButton", visible });
    this.trace(`[view] botón Launch ${visible ? "visible" : "oculto"}`);
  }

  /**
   * Fase 4 (P-032): ¿está la sección a la vista? Se consulta DESPUÉS de alternar
   * la barra, no antes, para no equivocarse si la sección está colapsada dentro
   * de una barra visible — ese caso se comportaría al revés.
   */
  get isVisible(): boolean {
    return this.view?.visible ?? false;
  }

  private post(msg: OutMsg): void {
    if (!this.ready) {
      return;
    }
    void this.view?.webview.postMessage(msg);
  }

  private syncState(): void {
    this.post({ type: "state", running: this.pty.isRunning });
  }

  /**
   * P-029 — Envía la tipografía real de `terminal.integrated` al xterm del
   * webview. Sin esto, la fuente NO es un color ⇒ VS Code no la expone por CSS y
   * el cliente se quedaría con la tipografía del editor (banner con métricas
   * distintas a las de la terminal auténtica).
   */
  private sendConfig(): void {
    const style = readTerminalStyle();
    this.post({ type: "config", style });
    this.trace(`[view] estilo de terminal → webview: ${describeTerminalStyle(style)}`);
  }

  private buildHtml(webview: vscode.Webview): string {
    const scriptUri = webview.asWebviewUri(
      vscode.Uri.file(path.join(this.context.extensionPath, "dist", "webview.js")),
    );
    const styleUri = webview.asWebviewUri(
      vscode.Uri.file(path.join(this.context.extensionPath, "dist", "webview.css")),
    );
    const nonce = getNonce();

    return /* html */ `<!DOCTYPE html>
<html lang="es">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy"
        content="default-src 'none'; style-src ${webview.cspSource}; script-src 'nonce-${nonce}';" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <link rel="stylesheet" href="${styleUri}" />
  <title>OpenCode</title>
</head>
<body>
  <!-- P-028: la sección ES la terminal. Sin botón mientras hay sesión; la barra
       de estado solo aparece en error o durante la guardia de instalación. -->
  <div id="status" class="status hidden">
    <span id="spinner" class="spinner hidden"></span>
    <span id="status-text" class="status-text"></span>
    <button id="output-btn" class="link-btn" title="${vscode.l10n.t("Open View → Output → OpenCode Chat")}">${vscode.l10n.t("output")}</button>
  </div>
  <!-- P-033: la sección vuelve al Launch tras cada salida visible de la sesión.
       Sin texto explicativo: si OpenCode no está instalado, la guardia de
       instalación (P-031) ya habla por sí sola cuando se pulsa. -->
  <div id="launch-panel" class="launch-panel hidden">
    <button id="launch-btn" class="launch-btn">${vscode.l10n.t("Launch OpenCode")}</button>
  </div>
  <div id="terminal" class="terminal"></div>
  <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
  }

  dispose(): void {
    for (const d of this.subs) {
      d.dispose();
    }
    for (const d of this.viewSubs) {
      d.dispose();
    }
    this.viewSubs = [];
    if (this.inputQuiet) {
      clearTimeout(this.inputQuiet);
      this.inputQuiet = undefined;
    }
  }
}

/** Nonce aleatorio para la CSP del webview. */
function getNonce(): string {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  let text = "";
  for (let i = 0; i < 32; i++) {
    text += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return text;
}
