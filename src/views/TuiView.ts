import * as vscode from "vscode";
import * as path from "path";
import type { OpenCodePty } from "../terminal/OpenCodePty";
import { STATUS_VIEW_ID } from "../utils/placement";
import { stamp } from "../utils/log";

/** Mensajes webview → extensión. */
type InMsg =
  | { type: "ready" }
  | { type: "launch" }
  | { type: "input"; data: string }
  | { type: "resize"; cols: number; rows: number };

/** Mensajes extensión → webview. */
type OutMsg = { type: "data"; data: string } | { type: "state"; running: boolean };

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
  private readonly subs: vscode.Disposable[] = [];
  /** Suscripciones del webview actual; se descartan si `resolveWebviewView` se repite. */
  private viewSubs: vscode.Disposable[] = [];

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly pty: OpenCodePty,
    private readonly output: vscode.OutputChannel,
  ) {
    // La PTY escribe → reenviar al webview (si ya está listo).
    this.subs.push(pty.onDidReceiveData(data => this.post({ type: "data", data })));
    // Estado cambia → el webview alterna entre botón Launch y TUI.
    this.subs.push(pty.onDidChangeState(() => this.syncState()));
  }

  resolveWebviewView(view: vscode.WebviewView): void {
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
    view.webview.html = this.buildHtml(view.webview);

    this.viewSubs.push(
      view.webview.onDidReceiveMessage((msg: InMsg) => {
        switch (msg?.type) {
          case "ready":
            this.ready = true;
            // Repintar con lo acumulado: con `retainContextWhenHidden` el webview
            // puede reabrirse con la TUI ya corriendo.
            const replay = this.pty.replayBuffer;
            if (replay) {
              this.post({ type: "data", data: replay });
            }
            this.syncState();
            this.output.appendLine(`${stamp()} [view] webview listo (replay=${replay.length}B)`);
            break;
          case "launch":
            // El botón Launch vive dentro del webview (reemplaza el viewsWelcome).
            this.pty.launch();
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

    // Al ocultarse/mostrarse la sección, re-enfocar el TUI si está corriendo.
    // Nota: `onDidChangeVisibility` es `Event<void>` — el estado está en `view.visible`.
    this.viewSubs.push(
      view.onDidChangeVisibility(() => {
        if (view.visible && this.pty.isRunning) {
          this.post({ type: "state", running: true });
        }
      }),
    );

    this.output.appendLine(`${stamp()} [view] webview resuelto`);
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
