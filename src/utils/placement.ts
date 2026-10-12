import * as vscode from "vscode";
import { stamp } from "./log";

/**
 * La vista de estado se DECLARA con la clave canónica **`explorer`** (P-019) y se MUEVE
 * en caliente al contenedor de Chat (`workbench.panel.chat`) — D7 rev.4.
 *
 * Clave, no id: `viewsExtensionPoint.getViewContainer()` resuelve
 * `case 'explorer' → registry.get(EXPLORER)` y para todo lo demás **prefija**
 * `workbench.view.extension.${value}` — por eso `workbench.panel.chat` (y cualquier
 * id crudo) da "contenedor no existe". Además, el contenedor de Chat es con longitud
 * fija `workbench.panel.chat`: **inalcanzable por prefijo** → el movimiento en caliente
 * es la única vía (y `ensureStatusViewInChat` lo hace one-shot, verificado en el fuente).
 *
 * Así Chat y OpenCode quedan visibles a la vez en la misma barra (secciones),
 * sin pestañas y sin tocar `workbench.activityBar.location` (P-018).
 */
export const STATUS_VIEW_ID = "opencodeChat.status";

/**
 * Contenedor de Chat en la Secondary Side Bar — registro core con `location: 2`
 * (`registerViewContainer({id:$J="workbench.panel.chat", ...}, 2)`), verificado
 * en el JS instalado 1.141 y en `workbench.auxiliarybar.pinnedPanels`.
 */
export const CHAT_CONTAINER_ID = "workbench.panel.chat";

/** Marcador diagnóstico (¿llegó a Chat alguna vez?). La colocación NO depende de él: se reafirma siempre. */
const STATUS_PLACED_FLAG = "opencodeChat.statusViewPlacedInChat";

/**
 * Mueve la sección OpenCode al contenedor de Chat — **se reafirma en CADA activación**.
 *
 * Por qué en caliente (P-019): el punto de extensión `views` se procesa ANTES de que
 * Chat registre su contenedor → el contenedor de Chat es inalcanzable por declaración
 * (`getViewContainer()` solo prefija `workbench.view.extension.`) → movemos en caliente.
 *
 * Por qué sin bandera one-shot (P-021): un drag & drop del usuario soltaba la vista
 * sobre la barra → `moveViewToLocation(vista, 2)` la mandaba a un **contenedor-servicio
 * generado** (`workbench.views.service.auxiliarybar.<uuid>`), invisible sin pestañas
 * (P-018); la bandera impedía repararla. Ahora cada arranque:
 *  - `vscode.moveViews` es **no-op** si ya está en Chat (`from === to`) — solo enfoca
 *    el contenedor (y devolvemos el foco abajo);
 *  - si está en otro sitio, la mueve al final ⇒ **queda debajo de Chat** (patrón
 *    Docker/Explorer: secciones apiladas con sash), y `cleanUpGeneratedViewContainer`
 *    **borra el contenedor-servicio huérfano** automáticamente.
 */
export async function ensureStatusViewInChat(
  output: vscode.OutputChannel,
  state: vscode.Memento,
): Promise<void> {
  const wasPlaced = state.get<boolean>(STATUS_PLACED_FLAG) === true;

  // Guardia: moveViews no lanza si el contenedor no existe. Si Chat aún no ha
  // cargado, no hacemos nada → se reintenta en el próximo arranque.
  const commands = await vscode.commands.getCommands(true);
  if (!commands.includes("workbench.action.chat.open")) {
    output.appendLine(
      `${stamp()} [place] Chat aún no cargado → movimiento de la vista aplazado al próximo arranque`,
    );
    return;
  }

  const before = vscode.window.activeTextEditor;
  try {
    await vscode.commands.executeCommand("vscode.moveViews", {
      viewIds: [STATUS_VIEW_ID],
      destinationId: CHAT_CONTAINER_ID,
    });
    await state.update(STATUS_PLACED_FLAG, true);
    output.appendLine(
      `${stamp()} [place] vista OpenCode → contenedor de Chat (${wasPlaced ? "reafirmada/reparada" : "movida"}; si hubo movimiento, al final = debajo de Chat)`,
    );
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    output.appendLine(`${stamp()} [place] no se pudo mover la vista: ${msg}`);
    return;
  }

  // moveViews enfoca el contenedor de Chat → devolver el foco al editor previo.
  if (before) {
    try {
      before.show();
    } catch {
      /* el editor puede haberse cerrado */
    }
  }
}

/**
 * `TERMINAL_VIEW_ID` y también el id de su VIEW_CONTAINER en el Panel
 * (fuente oficial: `contrib/terminal/browser/terminalView.ts` → id: TERMINAL_VIEW_ID).
 */
const TERMINAL_VIEW_ID = "terminal";

/** One-shot: solo restauramos la vista una vez por perfil. */
const RESTORED_FLAG = "opencodeChat.terminalViewRestored";

/**
 * §4 (D7, rev.2) — Corrige el intento previo de mover la vista Terminal entera.
 *
 * El `vscode.d.ts` de VS Code 1.141 (instalado) solo declara:
 *   TerminalLocation.Panel = 1  → dentro de la vista Terminal (panel)
 *   TerminalLocation.Editor = 2 → como pestaña de editor
 * **No existe ubicación de barra lateral para terminales**: mover la vista arrastraba
 * TODAS las terminales (la shell del usuario subió a la derecha) — error P-017.
 *
 * Restaura la vista `terminal` a su contenedor del Panel (one-shot con globalState).
 * No bloquea nunca el lanzamiento.
 */
export async function restoreTerminalView(
  output: vscode.OutputChannel,
  state: vscode.Memento,
): Promise<void> {
  if (state.get<boolean>(RESTORED_FLAG)) {
    return;
  }
  try {
    await vscode.commands.executeCommand("vscode.moveViews", {
      viewIds: [TERMINAL_VIEW_ID],
      destinationId: TERMINAL_VIEW_ID,
    });
    await state.update(RESTORED_FLAG, true);
    output.appendLine(
      `${stamp()} [place] vista 'terminal' devuelta al panel (one-shot de deshacer)`,
    );
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    output.appendLine(`${stamp()} [place] no se pudo restaurar la vista: ${msg}`);
  }
}
