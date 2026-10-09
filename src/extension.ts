import * as vscode from "vscode";
import { OpenCodeTerminal } from "./terminal/OpenCodeTerminal";
import { sendSelection } from "./commands/context";
import { stamp } from "./utils/log";

// Attribution (§0.4): patrón de terminal + sendText(x, false) tomado de la
// extensión oficial de OpenCode (`anomalyco/opencode/sdks/vscode`, MIT).

let terminal: OpenCodeTerminal | undefined;

export function activate(context: vscode.ExtensionContext): void {
  const output = vscode.window.createOutputChannel("OpenCode Chat");
  terminal = new OpenCodeTerminal(output);
  context.subscriptions.push(output, terminal);

  // --- Comandos (Fase 1: launch / focus / newSession / sendSelection) ---
  context.subscriptions.push(
    vscode.commands.registerCommand("opencodeChat.launch", () => terminal?.launch()),
    vscode.commands.registerCommand("opencodeChat.focus", () => terminal?.focus()),
    vscode.commands.registerCommand("opencodeChat.newSession", () => terminal?.newSession()),
    vscode.commands.registerCommand("opencodeChat.sendSelection", () =>
      terminal ? sendSelection(terminal) : undefined,
    ),
  );

  // --- Ciclo de vida (§7.3) — idempotente, sin leer el stdout del TUI ---
  // ② Shell integration: red de seguridad si `chainExit` está desactivado (T9).
  context.subscriptions.push(
    vscode.window.onDidStartTerminalShellExecution(e => {
      if (terminal?.matches(e.terminal)) {
        output.appendLine(`${stamp()} [shell:start] ${e.execution.commandLine.value}`);
      }
    }),
    vscode.window.onDidEndTerminalShellExecution(e => {
      if (!terminal?.matches(e.terminal)) {
        return;
      }
      const line = e.execution.commandLine.value;
      output.appendLine(`${stamp()} [shell:end] exitCode=${e.exitCode} cmd=${line}`);
      const disposeOnExit = vscode.workspace
        .getConfiguration("opencodeChat")
        .get<boolean>("disposeOnExit", true);
      if (disposeOnExit && /opencode/i.test(line)) {
        terminal.dispose();
      }
    }),
    // ③ Cierre manual (o cierre ya provocado por ①/②): limpiar el estado.
    vscode.window.onDidCloseTerminal(t => {
      if (terminal?.matches(t)) {
        output.appendLine(`${stamp()} [close] pestaña cerrada → estado = idle`);
        terminal.markClosed();
      }
    }),
    // T4: observar dónde está el foco (señal para el toggle de la Fase 4).
    vscode.window.onDidChangeActiveTerminal(t => {
      output.appendLine(`${stamp()} [active] ${t ? t.name : "(ninguna)"}`);
    }),
  );
}

export function deactivate(): void {
  terminal?.dispose();
}
