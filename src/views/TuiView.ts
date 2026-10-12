import * as vscode from "vscode";
import * as path from "path";
import type { OpenCodePty } from "../terminal/OpenCodePty";
import type { FileLog } from "../utils/filelog";
import { STATUS_VIEW_ID } from "../utils/placement";
import { stamp } from "../utils/log";

/** Mensajes webview → extensión. */
type InMsg =
  | { type: "ready" }
  | { type: "launch" }
  | { type: "input"; data: string }
  | { type: "resize"; cols: number; rows: number }
  | { type: "showOutput" };

/** Mensajes extensión → webview. */
type OutMsg =
  | { type: "data"; data: string }
  | { type: "state"; running: boolean }
  | { type: "status"; phase: string; detail: string };

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
  private lastStatus: { phase: string; detail: string } = { phase: "idle", detail: "" };
  private readonly subs: vscode.Disposable[] = [];
  /** Suscripciones del webview actual; se descartan si `resolveWebviewView` se repite. */
  private viewSubs: vscode.Disposable[] = [];

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly pty: OpenCodePty,
    private readonly output: vscode.OutputChannel,
    private readonly fileLog: FileLog,
  ) {
    // La PTY escribe → reenviar al webview (si ya está listo).
    this.subs.push(pty.onDidReceiveData(data => this.post({ type: "data", data })));
    // Estado cambia → el webview alterna entre botón Launch y TUI.
    this.subs.push(pty.onDidChangeState(() => this.syncState()));
    // P-025: fase real (idle/starting/running/exited/error) → panel + loader.
    this.subs.push(
      pty.onDidChangeStatus(s => {
        this.lastStatus = s;
        this.trace(`[status] ${s.phase} :: ${s.detail}`);
        this.post({ type: "status", phase: s.phase, detail: s.detail });
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

  resolveWebviewView(view: vscode.WebviewView): void {
    // P-025: nº de resoluciones. Si es >1, la vista se recreó (moveViews): hay
    // que re-sincronizar estado o el panel se quedaría clavado en "arrancando".
    this.resolveCount++;
    this.trace(
      `[view] resolveWebviewView #${this.resolveCount} (ready previo=${this.ready})`,
    );

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
        this.trace(`[view] mensaje recibido: ${msg?.type ?? "(sin type)"}`);
        switch (msg?.type) {
          case "ready": {
            this.ready = true;
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
            });
            this.trace(`[view] webview listo (replay=${replay.length}B)`);
            break;
          }
          case "launch":
            // El botón Launch vive dentro del webview (reemplaza el viewsWelcome).
            this.pty.launch();
            break;
          case "showOutput":
            // P-025: lo que pidió el usuario — la Salida estándar de VS Code
            // (View → Output → "OpenCode Chat"), como en cualquier otra extensión.
            this.output.show(true);
            break;
          case "input":
            this.pty.write(msg.data);
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

    this.trace("[view] webview resuelto");
  }

  /** §5.1: enfocar el TUI dentro de la sección. */
  focus(): void {
    void vscode.commands.executeCommand(`${STATUS_VIEW_ID}.focus`);
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
  <!-- P-025: barra de estado con la fase real de la PTY + enlace a la pestaña
       Salida (View → Output → "OpenCode Chat"), como en cualquier extensión. -->
  <div id="status" class="status">
    <span id="spinner" class="spinner hidden"></span>
    <span id="status-text" class="status-text">Listo para lanzar.</span>
    <button id="output-btn" class="link-btn" title="Abrir View → Output → OpenCode Chat">salida</button>
  </div>
  <div id="launch" class="launch">
    <p>OpenCode no está en ejecución.</p>
    <button id="launch-btn" class="vscode-button">Launch OpenCode Chat</button>
  </div>
  <div id="terminal" class="terminal hidden"></div>
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
