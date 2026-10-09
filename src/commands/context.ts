import * as vscode from "vscode";
import type { OpenCodeTerminal } from "../terminal/OpenCodeTerminal";

/**
 * §6: referencia de fichero con el MISMO formato que `getActiveFile()` de la
 * extensión oficial (`anomalyco/opencode/sdks/vscode`):
 *
 *   sin selección      → `@src/ruta/fichero.ts`
 *   línea única (L10)  → `@src/ruta/fichero.ts#L10`
 *   multilínea (10–20) → `@src/ruta/fichero.ts#L10-20`   ← sin segunda `L`
 */
export function buildFileRef(editor: vscode.TextEditor): string {
  const rel = vscode.workspace.asRelativePath(editor.document.uri, /* includeWorkspaceFolder */ false);
  const selection = editor.selection;

  if (selection.isEmpty) {
    return `@${rel}`;
  }

  const startLine = selection.start.line + 1;
  let endLine = selection.end.line + 1;
  // Selección que termina en la columna 0 de la siguiente línea → no cuenta.
  if (selection.end.character === 0 && endLine > startLine) {
    endLine -= 1;
  }
  if (startLine === endLine) {
    return `@${rel}#L${startLine}`;
  }
  return `@${rel}#L${startLine}-${endLine}`;
}

/**
 * §6: sanitización obligatoria para `sendText`.
 * - cada salto de línea se convertiría en un Enter → el TUI enviaría mensajes parciales;
 * - tope de 2000 caracteres (el compositor no es un bote de basura).
 */
export function sanitizeForComposer(text: string): string {
  return text
    .replace(/\r\n|\r|\n/g, " ")
    .replace(/[ \t]+/g, " ")
    .trim()
    .slice(0, 2000);
}

/** `opencodeChat.sendSelection` — inyecta el contexto del editor en el compositor (T7). */
export async function sendSelection(term: OpenCodeTerminal): Promise<void> {
  const editor = vscode.window.activeTextEditor;
  if (!editor) {
    void vscode.window.showWarningMessage("OpenCode: no hay editor activo.");
    return;
  }

  const ref = sanitizeForComposer(buildFileRef(editor));
  if (!term.instance) {
    await term.launch();
  }
  if (!term.sendToComposer(ref)) {
    void vscode.window.showWarningMessage("OpenCode: la terminal no está disponible.");
    return;
  }
}
