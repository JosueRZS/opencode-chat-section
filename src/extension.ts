import * as vscode from "vscode";
import { OpenCodePty } from "./terminal/OpenCodePty";
import { TuiViewProvider } from "./views/TuiView";
import { sendSelection } from "./commands/context";
import { restoreTerminalView, ensureStatusViewInChat } from "./utils/placement";
import { stamp } from "./utils/log";

// Attribution (§0.4): patrón de terminal + sendText(x, false) tomado de la
// extensión oficial de OpenCode (`anomalyco/opencode/sdks/vscode`, MIT).

let pty: OpenCodePty | undefined;
let view: TuiViewProvider | undefined;

export function activate(context: vscode.ExtensionContext): void {
  const output = vscode.window.createOutputChannel("OpenCode Chat");
  pty = new OpenCodePty(output);
  view = new TuiViewProvider(context, pty, output);
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
  void ensureStatusViewInChat(output, context.globalState);
  void restoreTerminalView(output, context.globalState);
  output.appendLine(`${stamp()} [activate] extensión activada (webview+pty)`);

  // --- Comandos (Fase 1: launch / focus / newSession / sendSelection) ---
  context.subscriptions.push(
    vscode.commands.registerCommand("opencodeChat.launch", () => pty?.launch()),
    vscode.commands.registerCommand("opencodeChat.focus", () => view?.focus()),
    vscode.commands.registerCommand("opencodeChat.newSession", () => pty?.newSession()),
    vscode.commands.registerCommand("opencodeChat.sendSelection", () =>
      pty ? sendSelection(pty) : undefined,
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
