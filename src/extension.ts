import * as vscode from "vscode";
import { OpenCodePty } from "./terminal/OpenCodePty";
import { TuiViewProvider } from "./views/TuiView";
import { sendSelection } from "./commands/context";
import { restoreTerminalView, ensureStatusViewInChat } from "./utils/placement";
import { FileLog } from "./utils/filelog";
import { stamp } from "./utils/log";

// Attribution (§0.4): patrón de terminal + sendText(x, false) tomado de la
// extensión oficial de OpenCode (`anomalyco/opencode/sdks/vscode`, MIT).

let pty: OpenCodePty | undefined;
let view: TuiViewProvider | undefined;

export function activate(context: vscode.ExtensionContext): void {
  const output = vscode.window.createOutputChannel("OpenCode Chat");
  // P-025: log a fichero con escritura síncrona. El OutputChannel de VS Code es
  // asíncrono y vive en el extension host: si el host se cuelga (P-024 causa 3),
  // las últimas líneas se pierden. Este log sobrevive.
  const fileLog = new FileLog("opencode-chat.log");
  fileLog.write(`=== extensión activada (pid ${process.pid}) ===`);
  // La Salida estándar (View → Output → "OpenCode Chat") es el canal público;
  // el fichero es el respaldo que sobrevive si el host se cuelga.
  output.appendLine(`${stamp()} [activate] extensión activada (pid ${process.pid})`);
  output.appendLine(`${stamp()} [activate] log de respaldo: ${fileLog.path}`);

  pty = new OpenCodePty(output, fileLog);
  view = new TuiViewProvider(context, pty, output, fileLog);
  context.subscriptions.push(output, pty, view);

  // --- Sección "OpenCode" dentro del contenedor de Chat (D7 rev.4/rev.5) ---
  // La vista se declara en Explorer (sin warnings, P-019) y se mueve en caliente a
  // Chat (reafirmada cada arranque, P-021); también deshace el movimiento indebido
  // de la vista Terminal (P-017).
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(TuiViewProvider.viewType, view, {
      // El TUI debe seguir vivo aunque la sección esté oculta: sin esto, ocultar
      // Chat destruiría el webview y perderíamos la pantalla del TUI.
      webviewOptions: { retainContextWhenHidden: true },
    }),
  );

  // El proveedor va ANTES del `moveViews`: mover la vista antes de haberla
  // declarado obliga al workbench a reconstruirla, y cada reconstrucción es una
  // oportunidad de perder el canal de mensajes webview↔extensión (P-026).
  void ensureStatusViewInChat(output, context.globalState, fileLog);
  void restoreTerminalView(output, context.globalState, fileLog);
  output.appendLine(`${stamp()} [activate] extensión activada (webview+pty)`);

  // --- Comandos (Fase 1: launch / focus / newSession / sendSelection) ---
  context.subscriptions.push(
    vscode.commands.registerCommand("opencodeChat.launch", () => {
      fileLog.write("[cmd] opencodeChat.launch ejecutado");
      pty?.launch();
    }),
    vscode.commands.registerCommand("opencodeChat.focus", () => view?.focus()),
    vscode.commands.registerCommand("opencodeChat.newSession", () => pty?.newSession()),
    vscode.commands.registerCommand("opencodeChat.sendSelection", () =>
      pty ? sendSelection(pty) : undefined,
    ),
    // P-025: el canal de Salida estándar (View → Output → "OpenCode Chat"),
    // que es como diagnostica cualquier otra extensión.
    vscode.commands.registerCommand("opencodeChat.showOutput", () =>
      output.show(true),
    ),
  );

  // --- Ciclo de vida (§7.3) — la señal es `onExit` de la PTY ---
  // Sin `onDidEndTerminalShellExecution` (P-016): no hay terminal de VS Code.
  // `chainExit` hace que la PTY muera con el TUI ⇒ se vuelve al botón Launch.
  output.appendLine(`${stamp()} [activate] ciclo de vida: PTY onExit`);
}

export function deactivate(): void {
  pty?.dispose();
}
