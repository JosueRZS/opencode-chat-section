import { isCmdShell } from "../utils/shell";
import { stamp } from "../utils/log";
import * as vscode from "vscode";

/**
 * La única terminal de la extensión — efímera (D1):
 * se crea en `launch()` y se elimina al salir de OpenCode o al cerrar la pestaña.
 * No hay puerto, ni env, ni llamadas HTTP (§1.1 / D3 v5).
 */
export class OpenCodeTerminal implements vscode.Disposable {
  private term: vscode.Terminal | undefined;

  constructor(private readonly output: vscode.OutputChannel) {}

  /** Terminal viva, si la creamos nosotros. */
  get instance(): vscode.Terminal | undefined {
    return this.term;
  }

  /** ¿Esta terminal es la nuestra? (para filtrar eventos globales de VS Code) */
  matches(candidate: vscode.Terminal): boolean {
    return this.term !== undefined && this.term === candidate;
  }

  /** La pestaña se fue (cierre manual, exit encadenado o shell integration). */
  markClosed(): void {
    this.term = undefined;
  }

  /**
   * §1.1: crea la terminal en la vista Terminal (arrastrable a la Secondary
   * Side Bar) y lanza OpenCode encadenando `exit` para que la pestaña muera
   * con el TUI. Si ya existe, solo la enfoca (una sola pestaña, §7.4).
   */
  async launch(): Promise<void> {
    if (this.term) {
      this.term.show(false);
      return;
    }

    const cfg = vscode.workspace.getConfiguration("opencodeChat");
    const term = vscode.window.createTerminal({
      name: "opencode",
      location: vscode.TerminalLocation.Panel, // NO ViewColumn.Beside (§4)
      cwd: resolveCwd(cfg.get<string>("terminalCwd")),
    });
    this.term = term;

    const focusOnLaunch = cfg.get<boolean>("focusOnLaunch", true);
    term.show(!focusOnLaunch);

    const chain = cfg.get<boolean>("chainExit", true);
    const sep = isCmdShell() ? "&" : ";"; // P-010
    this.output.appendLine(`${stamp()} [launch] sep='${sep}' chain=${chain} cwd=${term.creationOptions && "cwd" in term.creationOptions ? term.creationOptions.cwd ?? "(default)" : "(default)"}`);

    // Encadenar exit: al morir el TUI, el shell sale y VS Code cierra la pestaña (§7.3 ①).
    term.sendText(chain ? `opencode ${sep} exit` : "opencode");
  }

  /** §5.1: enfocar nuestra terminal; fallback a la vista Terminal. */
  focus(): void {
    if (this.term) {
      this.term.show(false);
      return;
    }
    void vscode.commands.executeCommand("workbench.action.terminal.focus");
  }

  /** §7.4: pestaña efímera → dispose y crear de nuevo. */
  async newSession(): Promise<void> {
    const old = this.term;
    this.term = undefined;
    old?.dispose();
    await this.launch();
  }

  /**
   * §1.1 ③ / T7: único canal hacia el TUI en v2 — teclear en el compositor
   * SIN enviar (addNewLine = false) para que el usuario revise y pulse Enter.
   */
  sendToComposer(text: string): boolean {
    if (!this.term) {
      return false;
    }
    this.term.sendText(text, false);
    return true;
  }

  dispose(): void {
    const old = this.term;
    this.term = undefined;
    old?.dispose();
  }
}

/** Resuelve `terminalCwd`: soporta `${workspaceFolder}` y `~`. */
function resolveCwd(value?: string): string | undefined {
  if (!value || !value.trim()) {
    return undefined;
  }
  const folder = vscode.workspace.workspaceFolders?.[0];
  let resolved = value.replace(/\$\{workspaceFolder\}/g, folder?.uri.fsPath ?? "");
  if (resolved === "~" || resolved.startsWith("~/") || resolved.startsWith("~\\")) {
    const home = process.env.USERPROFILE || process.env.HOME;
    if (home) {
      resolved = home + resolved.slice(1);
    }
  }
  resolved = resolved.trim();
  return resolved.length > 0 ? resolved : undefined;
}
