import * as vscode from "vscode";
import type { OpenCodeTerminal } from "../terminal/OpenCodeTerminal";
import { STATUS_VIEW_ID } from "../utils/placement";

/**
 * §4 (D7, rev.4) — La sección "OpenCode" DENTRO del contenedor de Chat
 * (`workbench.panel.chat`) en la Secondary Side Bar: Chat y OpenCode visibles
 * a la vez, uno debajo del otro, sin pestañas que se sustituyan (P-018).
 *
 * Se DECLARA con la clave `explorer` (P-019: el contenedor de Chat es inalcanzable
 * por declaración — `getViewContainer()` solo prefija `workbench.view.extension.` —
 * y las claves malas dan warning + Explorer) y `ensureStatusViewInChat()` la mueve
 * a Chat en caliente, un solo vez.
 *
 * Mientras la terminal no exista, VS Code muestra el `viewsWelcome` (botón Launch);
 * cuando la terminal está viva, se ve un nodo "opencode · en ejecución" que
 * al pulsarlo enfoca la terminal.
 *
 * NO es un chat ni una UI de OpenCode: es un indicador de la instancia efímera.
 */
type Node = "running";

export class StatusTreeProvider implements vscode.TreeDataProvider<Node> {
  private readonly emitter = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this.emitter.event;

  constructor(private readonly terminal: OpenCodeTerminal) {
    terminal.onDidChangeState(() => this.emitter.fire());
  }

  getTreeItem(): vscode.TreeItem {
    const item = new vscode.TreeItem("opencode", vscode.TreeItemCollapsibleState.None);
    item.id = "running";
    item.description = "en ejecución";
    item.iconPath = new vscode.ThemeIcon("comment-discussion");
    item.command = {
      command: "opencodeChat.focus",
      title: "OpenCode: Focus Terminal",
    };
    return item;
  }

  getChildren(element?: Node): Node[] {
    if (element) {
      return [];
    }
    return this.terminal.instance ? ["running"] : [];
  }

  dispose(): void {
    this.emitter.dispose();
  }
}

/** Registra la vista de estado dentro del contenedor de Chat (Secondary Side Bar). */
export function registerStatusView(context: vscode.ExtensionContext, terminal: OpenCodeTerminal): StatusTreeProvider {
  const provider = new StatusTreeProvider(terminal);
  context.subscriptions.push(
    vscode.window.registerTreeDataProvider(STATUS_VIEW_ID, provider),
    provider,
  );
  return provider;
}
