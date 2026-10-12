import { isCmdShell } from "../utils/shell";
import { stamp } from "../utils/log";
import * as vscode from "vscode";

/**
 * La única terminal de la extensión — efímera (D1):
 * se crea en `launch()` y se elimina al salir de OpenCode o al cerrarse.
 * No hay puerto, ni env, ni llamadas HTTP (§1.1 / D3 v5).
 *
 * D7 paso 2: se abre como **terminal editor** en la columna de la derecha
 * (`ViewColumn.Beside`) — su borde queda junto a Chat en la Secondary Side Bar
 * ("alado"). La sección OpenCode dentro del contenedor de Chat (D7 rev.4)
 * observa `onDidChangeState` para alternar entre welcome y "en ejecución".
 */
export class OpenCodeTerminal implements vscode.Disposable {
  private term: vscode.Terminal | undefined;
  private readonly stateEmitter = new vscode.EventEmitter<void>();

  /** Se dispara al crear/matar la terminal (vista de estado). */
  readonly onDidChangeState = this.stateEmitter.event;

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
    this.stateEmitter.fire();
  }

  /**
   * §1.1 + §4 (D7 paso 2): lanza OpenCode en un **terminal editor** a la derecha
   * (`ViewColumn.Beside`) — el único split horizontal de VS Code: los contenedores
   * de vistas en la barra son SIEMPRE verticales (P-020), y la extensión oficial
   * hace exactamente esto ("Create a new terminal in split screen"). Encadena
   * `exit` para que el editor muera con el TUI. Si ya existe, solo lo enfoca
   * (una sola terminal, §7.4). La sección OpenCode en la barra permanece siempre;
   * la terminal es lo efímero (D1).
   */
  async launch(): Promise<void> {
    if (this.term) {
      this.term.show(false);
      return;
    }

    const cfg = vscode.workspace.getConfiguration("opencodeChat");
    const focusOnLaunch = cfg.get<boolean>("focusOnLaunch", true);
    const term = vscode.window.createTerminal({
      name: "opencode",
      // D7 paso 2 — igual que la extensión oficial (MIT): split screen a la
      // derecha, borde a borde con la Secondary Side Bar (Chat). La vista
      // Terminal inferior NO se toca: ahí vive el shell del usuario (P-017).
      location: { viewColumn: vscode.ViewColumn.Beside, preserveFocus: !focusOnLaunch },
      cwd: resolveCwd(cfg.get<string>("terminalCwd")),
    });
    this.term = term;

    term.show(!focusOnLaunch);
    this.stateEmitter.fire();

    const chain = cfg.get<boolean>("chainExit", true);
    const sep = isCmdShell() ? "&" : ";"; // P-010
    this.output.appendLine(`${stamp()} [launch] loc=editor-beside focus=${focusOnLaunch} sep='${sep}' chain=${chain} cwd=${term.creationOptions && "cwd" in term.creationOptions ? term.creationOptions.cwd ?? "(default)" : "(default)"}`);

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
    this.stateEmitter.fire();
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
    // El emitter NO se dispone aquí: dispose() puede llamarlo la red de seguridad ②
    // y poder relanzar después (el provider de la vista sigue escuchando).
    this.stateEmitter.fire();
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
