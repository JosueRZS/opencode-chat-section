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
      `${stamp()} [place] Chat aun no cargado -> movimiento de la vista aplazado al proximo arranque`,
    );
    fileLog?.write("[place] Chat AUN NO CARGADO -> movimiento aplazado (workbench.action.chat.open ausente)");
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
      `${stamp()} [place] vista OpenCode -> contenedor de Chat (${wasPlaced ? "reafirmada/reparada" : "movida"}; si hubo movimiento, al final = debajo de Chat)`,
    );
    fileLog?.write(
      `[place] moveViews OK (${wasPlaced ? "reafirmada/reparada" : "movida"}) -> ${CHAT_CONTAINER_ID}`,
    );
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    output.appendLine(`${stamp()} [place] no se pudo mover la vista: ${msg}`);
    fileLog?.write(`[place] moveViews FALLO: ${msg}`);
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

/** Retardo solo del respaldo por foco (el camino normal ya no lo necesita). */
const FOCUS_SETTLE = 450;

/** Espera tras quitar el foco de las vistas, para que `onDidBlurView` se asiente. */
const BLUR_SETTLE = 200;

/**
 * P-038 — Fija `focusedView` sin depender del DOM.
 *
 * `XKe.run` (`views.moveViewDown`) decide QUÉ vista mueve leyendo la clave de
 * contexto `focusedView`:
 *
 *     let n = td.getValue(i);              // td = RawContextKey("focusedView", "")
 *     if (n === void 0) return;            // "" NO es undefined → no protege
 *     let r = getViewContainerByViewId(n), // "" → null
 *         a = getViewContainerModel(r);    // → null.storageId → TypeError
 *
 * El valor real lo escribe `ViewPaneContainer.addPane` cuando el pane dispara
 * `onDidFocus`, y eso en una vista de webview **no llega nunca por programa**:
 * `ViewPane.focus()` solo emite si tras `element.focus()` el activo es el propio
 * elemento o está dentro de él (`Na`/`hr`), y el `FocusTracker` del pane escucha
 * `focus` **en captura** sobre el div del pane — el evento que dispara el
 * navegador al enfocar un iframe se emite en el elemento `<iframe>`, y el foco
 * dentro del documento del webview no propaga hacia el documento padre.
 * Por eso el intento previo (enfocar + esperar 450 ms) devolvía siempre
 * `focusedView === ""` y acababa en el TypeError de arriba.
 *
 * `setContext`/`_setContext` escriben directamente en `IContextKeyService`
 * (`Dkr(s,o,e){ s.get(ee).createKey(String(o), Rkr(e)) }`, y `ee` es el mismo
 * servicio que lee `XKe.run`), así que la clave queda exactamente donde la lee
 * el mandato. Se restaura a `""` (= `reset()`, el valor por defecto) al terminar.
 *
 * Ventaja de seguridad: al fijarla NOSOTROS a nuestra vista, el mandato no
 * puede acabar reordenando la sección de otro.
 */
async function setFocusedViewKey(value: string): Promise<boolean> {
  for (const cmd of ["setContext", "_setContext"]) {
    try {
      await vscode.commands.executeCommand(cmd, "focusedView", value);
      return true;
    } catch {
      /* el id puede no estar registrado en esta versión → siguiente candidato */
    }
  }
  return false;
}

/** P-042 — una sola vez: repara el estado que el P-039 dejó marcado como oculto. */
const MIGRATION_FLAG = "opencodeChat.visibilityRestoredOnce";

/** P-042 — una reconstrucción de panes quedó interrumpida a medias por nosotros. */
const REBUILD_IN_FLIGHT_FLAG = "opencodeChat.rebuildInFlight";

/**
 * P-041/P-042 — Que la sección vuelva al arrancar, pero SIN pisar una
 * ocultación deliberada del usuario.
 *
 * ## Por qué una vista oculta no vuelve sola
 *
 * El modelo del contenedor persiste si cada vista está visible
 * (`viewDescriptorsState` → `updateGlobalState` escribe `isHidden`), y al
 * arrancar el `ViewPaneContainer` se reconstruye leyendo exactamente eso:
 *
 *   let c = this.viewContainerModel.visibleViewDescriptors
 *             .map((l,u) => ({viewDescriptor:l, index:u, …})); c.length && this.onDidAddViewDescriptors(c);
 *
 * "Oculta porque la ocultó el usuario" y "oculta porque un fallo nuestro la
 * ocultó" son el MISMO `isHidden = true` en ese storage. No se distinguen
 * mirando el modelo, así que la regla se ha construido para no tener que
 * adivinar la intención:
 *
 *   **Solo se repone cuando hay constancia de que la ocultamos NOSOTROS.**
 *
 * Hay exactamente dos casos, y ambos quedan registrados por nosotros mismos:
 *
 *  1. `REBUILD_IN_FLIGHT_FLAG` — se levanta antes del `toggleVisibility` del
 *     P-040 y se retira SOLO si el paso final (reinsertar la nuestra) terminó.
 *     Si al arrancar sigue puesto, el host murió a medias de la secuencia y la
 *     sección quedó oculta por nuestra cuenta → se repone.
 *
 *  2. `MIGRATION_FLAG` — una sola vez. La reparación del estado que el P-039
 *     dejó marcado como oculto sin que el usuario hiciera nada. A partir de
 *     esa ejecución la bandera está puesta y la activación ya no vuelve a tocar
 *     la visibilidad: lo que decidas a partir de ahí se respeta siempre.
 *
 * Es decir: la ocultación manual no necesita ser DETECTADA, solo respetada —
 * y se respeta porque el único automático que queda corre una vez.
 *
 * ## La palanca
 *
 * `openView` solo alterna si el pane no existe, así que con la sección ya a la
 * vista es un no-op: no puede ocultar nada. Con `{preserveFocus:true}` no mueve
 * el foco. Y al llegar en la activación el estado es siempre consistente (acaba
 * de reconstruirse desde el modelo), que es la única condición en la que
 * "alterna si falta" equivale a "muestra".
 */
export async function ensureStatusViewVisible(
  output: vscode.OutputChannel,
  state: vscode.Memento,
  fileLog?: FileLog,
): Promise<void> {
  const migrated = state.get<boolean>(MIGRATION_FLAG) === true;
  const inFlight = state.get<boolean>(REBUILD_IN_FLIGHT_FLAG) === true;

  if (!migrated && !inFlight) {
    output.appendLine(`${stamp()} [place] primera vision tras el P-042 -> reponiendo la seccion una vez`);
    await showStatusView(output, state, MIGRATION_FLAG, fileLog);
    return;
  }
  if (inFlight) {
    output.appendLine(`${stamp()} [place] reconstruccion interrumpida a medias -> reponiendo la seccion`);
    await showStatusView(output, state, REBUILD_IN_FLIGHT_FLAG, fileLog);
    return;
  }
  fileLog?.write("[place] visibilidad de la seccion intacta: se respeta lo que decida el usuario");
}

async function showStatusView(
  output: vscode.OutputChannel,
  state: vscode.Memento,
  clearFlag: string,
  fileLog?: FileLog,
): Promise<void> {
  try {
    await vscode.commands.executeCommand(`${STATUS_VIEW_ID}.focus`, { preserveFocus: true });
    await state.update(clearFlag, false);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    output.appendLine(`${stamp()} [place] no se pudo asegurar la visibilidad de la seccion: ${msg}`);
    fileLog?.write(`[place] ${STATUS_VIEW_ID}.focus fallo: ${msg}`);
  }
}

/**
 * P-043 — Por qué aquí ya NO se reconstruye ningún pane.
 *
 * El diseño anterior (P-040) alternaba la visibilidad de la vista de Chat dos
 * veces para forzar que `ViewPaneContainer` reconstruyera su DOM en el orden del
 * modelo. Funcionaba — y era exactamente lo que vaciaba la conversación de
 * Copilot Chat: `openView` sobre una vista AUSENTE la vuelve a añadir, y añadir
 * una vista de webview significa destruir y recrear su webview, con lo que todo
 * lo que solo vivía en memoria se pierde.
 *
 * No era un detalle de implementación, era insalvable. `ViewPaneContainer`
 * aplica los eventos del modelo como ÍNDICES del array de panes, así que una vez
 * que `moveViewDown` ha reordenado el modelo, alternar la visibilidad de la
 * nuestra retira el pane que ocupa ese índice EN PANTALLA — que ya es el de Chat.
 * Es decir: la llamada a la vista de Chat no reparaba un daño accidental, era el
 * paso inevitable de la propia secuencia. Y con la API pública no hay forma de
 * leer el orden del DOM, luego tampoco de saber si los índices cruzados van a
 * dañar a un tercero.
 *
 * La regla que queda es simple y verificable: **esta extensión no emite ningún
 * mandato sobre una vista que no sea la suya.** `moveViewDown` reescribe
 * `state.order`, que es estado PERSISTENTE; el orden visible lo recupera el
 * contenedor al reconstruirse, cosa que ocurre sola (recargar la ventana, u
 * ocultar y volver a mostrar la barra lateral).
 *
 * Lo que se pierde: ver el cambio al instante tras arrastrar. Lo que se gana:
 * que Copilot Chat deje de perder su conversación. Con la API actual no hay
 * término medio.
 */

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
 *    llegamos a fijar la nuestra, el mandato se rechaza en vez de actuar mal.
 *  - `_tryExecuteCommand` **no** comprueba la precondition, de modo que
 *    `focusedView != ""` no es un obstáculo desde la extensión; el cerrojo es
 *    solo el `if(n===void 0) return` y el `getViewContainerByViewId`.
 *  - Con `l+offset >= length` devuelve **sin error** al estar en el borde, así
 *    que repetir hasta `MAX_ORDER_STEPS` es idempotente y no puede pasarse.
 *
 * P-038 — cómo se fija `focusedView`: ver `setFocusedViewKey`. La vía por foco
 * (P-036) se demostró inviable en una vista de webview y solo queda como
 * respaldo si los mandatos `setContext`/`_setContext` no existieran.
 *
 * P-037/038 — el registro es a CANAL DE SALIDA Y a fichero: este mandato es el
 * que el usuario tiene que leer en View → Output, y antes sus trazas solo
 * llegaban al fichero.
 *
 * P-043 — aquí termina TODO lo que toca el mandato. Lo que se reescribe es
 * `state.order`, que es estado persistente; la pantalla no se toca en absoluto
 * (ver `ensurePanesPresent`/`rebuildPanesOrder`, retiradas, y el motivo).
 */
export async function restoreViewOrder(
  output: vscode.OutputChannel,
  fileLog?: FileLog,
): Promise<OrderResult> {
  const MOVE_DOWN = "views.moveViewDown";
  const MAX_STEPS = 12;
  const delay = (ms: number) => new Promise<void>(r => setTimeout(r, ms));

  const trace = (msg: string): void => {
    output.appendLine(`${stamp()} ${msg}`);
    fileLog?.write(msg);
  };

  // 1. Sacar el foco de cualquier vista. Además de dejar `focusedView` limpio
  //    (`onDidBlurView` → `reset()` → `""`), evita que un foco remanente dispare
  //    `onDidFocusView` a mitad del bucle y pise lo que fijamos en el paso 2.
  try {
    await vscode.commands.executeCommand("workbench.action.focusActiveEditorGroup");
    await delay(BLUR_SETTLE);
  } catch {
    /* sin editor abierto: se sigue adelante, el paso 2 fija la clave igualmente */
  }

  // 2. Fijar `focusedView` a nuestra vista. Se vuelve a fijar en CADA vuelta por
  //    si algún evento de foco la vaciara entre iteraciones.
  const forced = await setFocusedViewKey(STATUS_VIEW_ID);
  if (forced) {
    trace(
      `[place] focusedView := ${STATUS_VIEW_ID} via setContext (directo en IContextKeyService; ` +
        `no depende de que el webview confirme el foco)`,
    );
  } else {
    trace(`[place] setContext/_setContext no disponibles -> respaldo: ${STATUS_VIEW_ID}.focus + ${FOCUS_SETTLE} ms`);
  }

  let rejects = 0;
  let accepted = 0;

  // P-043 — aquí NO se toca ninguna vista que no sea la nuestra. Ver el
  // comentario de `restoreViewOrder`: reconstruir panes exige alternar la
  // visibilidad, y eso sobre la vista de Chat destruye su webview (y con él la
  // conversación). El orden del modelo se corrige solo con `moveViewDown`.

  try {
    for (let step = 0; step < MAX_STEPS && rejects < 2; step++) {
      if (forced) {
        await setFocusedViewKey(STATUS_VIEW_ID);
      }
      // Respaldo (P-036): enfocar de verdad y esperar el ida y vuelta del
      // webview. En una vista de webview este camino NO emite `onDidFocus`
      // (ver `setFocusedViewKey`), así que solo se recurre a él cuando no hay
      // `setContext` o cuando el primero ya ha fallado una vez.
      if (!forced || rejects > 0) {
        try {
          await vscode.commands.executeCommand(`${STATUS_VIEW_ID}.focus`);
          await delay(FOCUS_SETTLE);
        } catch {
          /* la vista puede no estar resuelta todavía */
        }
      }
      try {
        await vscode.commands.executeCommand(MOVE_DOWN);
        accepted++;
        rejects = 0;
      } catch (e) {
        rejects++;
        const msg = e instanceof Error ? e.message : String(e);
        trace(`[place] ${MOVE_DOWN} rechazado (intento ${rejects}): ${msg}`);
      }
    }
  } finally {
    // 3. Devolver la clave a su valor por defecto (= `reset()`): al salir, el foco
    //    vuelve al editor, donde `focusedView` es `""`.
    if (forced) {
      await setFocusedViewKey("");
    }
    try {
      await vscode.commands.executeCommand("workbench.action.focusActiveEditorGroup");
    } catch {
      /* sin editor abierto: no hay a dónde volver el foco */
    }
  }

  if (rejects >= 2) {
    trace("[place] ORDEN NO RESTAURADO: focusedView nunca fue nuestra vista");
    return "no-focus";
  }
  trace(
    `[place] orden restaurado: ${accepted} llamada(s) a ${MOVE_DOWN} sin rechazo ` +
      `(en el borde son no-op, por eso el bucle es idempotente) -> la vista queda la ultima del contenedor`,
  );
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
