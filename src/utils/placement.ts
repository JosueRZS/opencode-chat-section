import * as vscode from "vscode";
import type { FileLog } from "./filelog";
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
 * Resultado de la restauración, para que el comando pueda informar en la
 * superficie y no solo en el canal de Salida.
 *  - `ok`: la vista está (o acaba de volver) en su contenedor.
 *  - `chat-not-loaded`: Chat aún no registró su contenedor, no se puede mover.
 *  - `error`: `vscode.moveViews` falló.
 */
export type PlaceResult = "ok" | "chat-not-loaded" | "error";

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
 *
 * Es la misma rutina que invoca `opencodeChat.restorePosition`: moverla a mano es
 * indistinguible de reafirmarla al arrancar, así que no hay dos caminos que
 * puedan divergir.
 */
export async function ensureStatusViewInChat(
  output: vscode.OutputChannel,
  state: vscode.Memento,
  fileLog?: FileLog,
): Promise<PlaceResult> {
  const wasPlaced = state.get<boolean>(STATUS_PLACED_FLAG) === true;

  // Guardia: moveViews no lanza si el contenedor no existe. Si Chat aún no ha
  // cargado, no hacemos nada → se reintenta en el próximo arranque.
  const commands = await vscode.commands.getCommands(true);
  if (!commands.includes("workbench.action.chat.open")) {
    output.appendLine(
      `${stamp()} [place] Chat aún no cargado → movimiento de la vista aplazado al próximo arranque`,
    );
    fileLog?.write("[place] Chat AÚN NO CARGADO → movimiento aplazado (workbench.action.chat.open ausente)");
    return "chat-not-loaded";
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
    fileLog?.write(
      `[place] moveViews OK (${wasPlaced ? "reafirmada/reparada" : "movida"}) → ${CHAT_CONTAINER_ID}`,
    );
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    output.appendLine(`${stamp()} [place] no se pudo mover la vista: ${msg}`);
    fileLog?.write(`[place] moveViews FALLÓ: ${msg}`);
    return "error";
  }

  // moveViews enfoca el contenedor de Chat → devolver el foco al editor previo.
  if (before) {
    try {
      before.show();
    } catch {
      /* el editor puede haberse cerrado */
    }
  }
  return "ok";
}

/**
 * Resultado de la restauración de ORDEN (distinto de la de contenedor).
 *  - `ok`: `views.moveViewDown` aceptó la llamada, con lo que `focusedView`
 *    apuntaba a nuestra vista y se reescribió `state.order`.
 *  - `no-focus`: el mandato fue rechazado dos veces seguidas — `focusedView`
 *    no era nuestra vista y no lo conseguimos fijar. No se movió nada.
 */
export type OrderResult = "ok" | "no-focus";

/**
 * P-035 — Empuja la sección al FINAL del contenedor: debajo de Chat.
 *
 * Por qué hace falta (extraído del workbench de VS Code 1.141, no supuesto):
 *
 * `ViewDescriptorService.moveViewsToContainer(e,t,i,n)` empieza con la guarda
 * `r&&a&&r!==a&&(...)`, donde `r` es el contenedor ACTUAL de la vista y `a` el
 * destino. Si ya está en destino, **no hace absolutamente nada** — por eso el
 * P-034 devolvía `ok` sin mover la vista cuando el usuario la había arrastrado
 * por encima de Chat dentro del mismo contenedor.
 *
 * El orden lo fija `ViewContainerModel.compareViewDescriptors` → `getViewOrder`:
 *
 *     let t = typeof e.state.order == "number" ? e.state.order : e.viewDescriptor.order;
 *     return typeof t == "number" ? t : Number.MAX_VALUE;
 *
 *  - Vista que nadie ha arrastrado: sin `state.order` ⇒ `MAX_VALUE` ⇒ ordena la
 *    última ⇒ **debajo de Chat**. Así funcionaba el diseño original.
 *  - Tras un arrastre, `ViewContainerModel.move` escribe `state.order = 0..n-1`
 *    sobre el estado que `viewDescriptorsState` guarda **en storage**
 *    (`createInstance(oxt, storageId)`) ⇒ la vista queda arriba para siempre, y
 *    ni un nuevo arranque lo arregla.
 *
 * El único punto que reescribe `state.order` es `ViewContainerModel.move`, y lo
 * alcanza un único mandato registrado: `views.moveViewDown` (clase con
 * `offset = 1`). Por eso se usa ese y no `vscode.moveViews`.
 *
 * Lo que hace falta para que actúe, todo verificado en el fuente:
 *  - `XKe.run` lee `focusedView`; si es distinto de la nuestra, movería la vista
 *    de OTRO — el fallo grave. Por eso **primero se vacía** enfocando el editor
 *    (`onDidBlurView` → `focusedViewContextKey.reset()`); así, si después no
 *    llegamos a enfocar la nuestra, el mandato se rechaza en vez de actuar mal.
 *  - `_tryExecuteCommand` **no** comprueba la precondition, de modo que
 *    `focusedView != ""` no es un obstáculo desde la extensión; el cerrojo es
 *    solo el `if(n===void 0) return` y el `getViewContainerByViewId`.
 *  - Con `l+offset >= length` devuelve **sin error** al estar en el borde, así
 *    que repetir hasta `MAX_ORDER_STEPS` es idempotente y no puede pasarse.
 */
export async function restoreViewOrder(fileLog?: FileLog): Promise<OrderResult> {
  const MOVE_DOWN = "views.moveViewDown";
  const MAX_STEPS = 12;
  const SETTLE = 80;

  const settle = () => new Promise<void>(r => setTimeout(r, SETTLE));

  // 1. Vaciar `focusedView`. Es lo que convierte un fallo de foco en un
  //    rechazo detectable en vez de en un mandato que reordena a otro.
  try {
    await vscode.commands.executeCommand("workbench.action.focusActiveEditorGroup");
    await settle();
  } catch {
    /* sin editor abierto: se sigue adelante, el paso 2 fija el foco igualmente */
  }

  // 2. Subir nuestro foco y bajar la vista. Se re-enfoca en CADA vuelta: si un
  //    reordenado dispara `onDidBlurView` y vacía la clave, el siguiente intento
  //    vuelve a fijarla.
  let rejects = 0;
  for (let step = 0; step < MAX_STEPS; step++) {
    if (rejects >= 2) {
      break;
    }
    try {
      await vscode.commands.executeCommand(`${STATUS_VIEW_ID}.focus`);
      await settle();
      await vscode.commands.executeCommand(MOVE_DOWN);
      rejects = 0;
    } catch (e) {
      rejects++;
      const msg = e instanceof Error ? e.message : String(e);
      fileLog?.write(`[place] ${MOVE_DOWN} rechazado (intento ${rejects}): ${msg}`);
    }
  }

  if (rejects >= 2) {
    fileLog?.write("[place] ORDEN NO RESTAURADO: focusedView nunca fue nuestra vista");
    return "no-focus";
  }
  fileLog?.write("[place] orden restaurado: vista empujada al final del contenedor");
  return "ok";
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
  fileLog?: FileLog,
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
