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
    output.appendLine(`${stamp()} [place] primera visión tras el P-042 → reponiendo la sección una vez`);
    await showStatusView(output, state, MIGRATION_FLAG, fileLog);
    return;
  }
  if (inFlight) {
    output.appendLine(`${stamp()} [place] reconstrucción interrumpida a medias → reponiendo la sección`);
    await showStatusView(output, state, REBUILD_IN_FLIGHT_FLAG, fileLog);
    return;
  }
  fileLog?.write("[place] visibilidad de la sección intacta: se respeta lo que decida el usuario");
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
    output.appendLine(`${stamp()} [place] no se pudo asegurar la visibilidad de la sección: ${msg}`);
    fileLog?.write(`[place] ${STATUS_VIEW_ID}.focus falló: ${msg}`);
  }
}

/**
 * Descubre el id de la vista de Chat dentro de `workbench.panel.chat`.
 *
 * El contenedor lo declara el propio workbench con una plantilla
 * (`Ba = \`workbench.panel.chat.view.${_Ue}\``), y el mandato de foco que de él
 * se registra es exactamente `<vista>.focus`. Como `vscode.commands.getCommands`
 * lista todos los mandatos registrados, basta con filtrar por ese patrón:
 * descubrimos el id sin fijarlo a mano y sin depender de que la sufija (`copilot`)
 * se mantenga entre versiones.
 */
async function discoverChatViewId(): Promise<string | undefined> {
  const commands = await vscode.commands.getCommands(true);
  const pattern = /^(workbench\.panel\.chat\.view\.[^.]+)\.focus$/;
  for (const id of commands) {
    const m = pattern.exec(id);
    if (m) {
      return m[1];
    }
  }
  // Respaldo por si el patrón deja de valer: solo se usa si el mandato existe.
  return commands.includes(`${CHAT_VIEW_FALLBACK}.focus`) ? CHAT_VIEW_FALLBACK : undefined;
}

/** Espera entre operaciones de pane, para que el contenedor aplique el evento. */
const PANE_SETTLE = 250;

/** Respaldo: id de la vista de Chat dentro de `workbench.panel.chat` en 1.141. */
const CHAT_VIEW_FALLBACK = "workbench.panel.chat.view.copilot";

/**
 * P-040 — Sincroniza la PANTALLA con el modelo, y de paso repara daños previos.
 *
 * ## Por qué hace falta
 *
 * En el workbench de 1.141 solo hay dos puntos que reordenan y solo uno toca el DOM:
 *
 *   // la del mandato — SOLO modelo + storage
 *   XKe.run (views.moveViewUp/Down/Left/Right): a.move(c.id, u.id)
 *
 *   // la del drag & drop — modelo Y DOM
 *   ViewPaneContainer.movePane(e,t){ …paneItems.splice(n,0,c),
 *                                    paneview.movePane(e,t),
 *                                    viewContainerModel.move(r.id,a.id) }
 *
 * `_onDidMoveVisibleViewDescriptors`, el único evento que emite `move()`, tiene
 * UN SOLO suscriptor en todo el bundle (`registerViewsVisibilityActions`,
 * repinta menús) y los seis llamadores de `movePane` son manejadores de drop.
 * Luego `moveViewDown` deja el modelo reordenado y la pantalla como estaba.
 *
 * ## Por qué es peligroso tocar la visibilidad después
 *
 * `ViewPaneContainer` NO mira el id al aplicar los eventos del modelo: los usa
 * como ÍNDICES del array de panes.
 *
 *   onDidRemoveViewDescriptors(e){ …for(let{index:i}of e)
 *       this.paneItems[i] && t.push(this.paneItems[i].pane) }
 *
 *   onDidAddViewDescriptors(e){ …t.push({pane:l,size:c, index:a, …}) }
 *   addPane(e,t,i,n){ …this.paneItems.splice(n,0,g), paneview.addPane(e,t,n) }
 *
 * Si el orden del modelo y el del DOM difieren, «ocultar la vista X» retira el
 * pane que OCUPA LA POSICIÓN de X en pantalla — no el de X. Fue exactamente el
 * fallo del P-039: el modelo decía `[chat, openCode]` y la pantalla seguía en
 * `[openCode, chat]`, así que ocultar la nuestra (índice 1) se cargó el pane de
 * Chat y el contenedor quedó *merged* con título `CHAT: OPENCODE`.
 *
 * ## Las dos palancas, verificadas en el fuente
 *
 *   toggleVisibility(id)  → model.setVisible(id, !vis) → evento con el índice
 *                           del MODELO. Es la única forma de retirar un pane.
 *
 *   <id>.focus            → ViewPaneContainer.openView:
 *                             let i=this.getView(e); return i||this.toggleViewVisibility(e),
 *                                    i=this.getView(e), i&&(i.setExpanded(!0), t&&i.focus()), i
 *                           **Solo alterna si el pane NO existe.** Con
 *                           `{preserveFocus:true}` no mueve el foco. Esto lo
 *                           convierte en «asegura visible» (idempotente), y su
 *                           gemelo «asegura oculto» cuando el pane falta.
 *
 * ## La secuencia
 *
 *   P. `ensurePanesPresent` (antes del movimiento) — `<chat>.focus` ×2 y
 *      `<nuestra>.focus`: si falta algún pane lo repone (y al hacerlo vacía el
 *      DOM, que es el estado de orden cero). Con todo presente, no-op.
 *   M. `views.moveViewDown` — reescribe `state.order` (ambas visibles).
 *   R1 `<nuestra>.toggleVisibility` — retira la nuestra.
 *   R2 `<chat>.focus` ×2 — si R1 retiró la de Chat, la primera vacía el DOM y
 *      la segunda la repone; si no, ambas son no-op.
 *   R3 `<nuestra>.focus` — la reinserta en `visibleIndex` del modelo ordenado.
 *
 * Al terminar `paneItems` y `visibleViewDescriptors` vuelven a coincidir, así
 * que la siguiente ejecución arranca en caja limpia (y entonces R2/R3 no tocan
 * Chat en absoluto). Los tres estados de partida posibles dan el mismo final:
 *
 *   · correcto            → solo se reconstruye la nuestra; Chat ni se mueve.
 *   · orden invertido     → R1 retira la de Chat (índice 1), R2 vacía y repone,
 *                           R3 reinserta la nuestra al final.
 *   · daño previo (P-039) → P lo repara entero antes de mover nada.
 *
 * Coste: se recrea el `WebviewView`. `TuiView` lo soporta desde P-025
 * (`resolveCount`, descarte de suscripciones viejas, y en `ready` reenvía el
 * replay de la PTY, la fase y el botón Launch): el TUI se repinta sin reiniciar.
 */
/** `<id>.focus` con `preserveFocus` — llega a `openView(id, !r?.preserveFocus)`. */
async function ensureViewVisible(
  viewId: string,
  output: vscode.OutputChannel,
  fileLog?: FileLog,
): Promise<void> {
  try {
    await vscode.commands.executeCommand(`${viewId}.focus`, { preserveFocus: true });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    output.appendLine(`${stamp()} [place] ${viewId}.focus no disponible (${msg})`);
    fileLog?.write(`[place] ${viewId}.focus no disponible: ${msg}`);
  }
  await new Promise<void>(r => setTimeout(r, PANE_SETTLE));
}

async function rebuildPanesOrder(
  output: vscode.OutputChannel,
  chatViewId: string | undefined,
  state: vscode.Memento,
  fileLog?: FileLog,
): Promise<void> {
  const trace = (msg: string): void => {
    output.appendLine(`${stamp()} ${msg}`);
    fileLog?.write(msg);
  };
  const delay = (ms: number) => new Promise<void>(r => setTimeout(r, ms));
  const ensureVisible = (viewId: string) => ensureViewVisible(viewId, output, fileLog);

  // R1 — retirar la nuestra. Es el único paso que exige el mandato de
  // visibilidad; si no existe, no se reconstruye nada (se evita a propósito:
  // sin R2 no habría forma de devolver el pane de Chat).
  const TOGGLE = `${STATUS_VIEW_ID}.toggleVisibility`;
  let hid = false;
  try {
    await state.update(REBUILD_IN_FLIGHT_FLAG, true);
    await vscode.commands.executeCommand(TOGGLE);
    hid = true;
    await delay(PANE_SETTLE);
    trace(`[place] ${TOGGLE} → pane retirado`);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    trace(`[place] ${TOGGLE} no disponible (${msg}) → pantalla sin actualizar`);
    if (!hid) {
      // Nada se ocultó: la marca de "a medias" no debe sobrevivir.
      await state.update(REBUILD_IN_FLIGHT_FLAG, false);
    }
    return;
  }

  // R2 — si R1 se llevó por delante el pane de Chat (índices cruzados), la
  // primera llamada vacía el DOM y la segunda lo repone. Si Chat seguía intacto
  // las dos son no-op.
  if (chatViewId) {
    await ensureVisible(chatViewId);
    await ensureVisible(chatViewId);
  }

  // R3 — reinsertar la nuestra en `visibleIndex` del modelo ya ordenado.
  await ensureVisible(STATUS_VIEW_ID);

  // P-042 — solo aquí se retira la marca, y solo si R3 terminó. Si el host
  // muere entre R1 y R3, la sección queda oculta por nuestra cuenta y la
  // próxima activación lo detecta por esta misma bandera y la repone.
  await state.update(REBUILD_IN_FLIGHT_FLAG, false);
  trace(`[place] panes reconstruidos en el orden del modelo (pantalla = modelo)`);
}

/**
 * P-040 (previo) — Garantiza que el modelo y la pantalla cuenten con las MISMAS
 * vistas antes de tocar nada.
 *
 * Es la fase que repara el estado que los refrescos del P-039 dejaron
 * inconsistentes (un pane retirado del DOM mientras el modelo seguía creyéndolo
 * visible). La palanca es `openView`, que **solo alterna la visibilidad cuando
 * el pane no existe**:
 *
 *   · pane presente  → no-op, no se mueve nada.
 *   · pane ausente   → alterna, y al hacerlo emite el evento con el índice del
 *                      modelo: si ese índice apunta a otro pane (que es justo el
 *                      síntoma de la inconsistencia) lo retira, vaciando el
 *                      array. La segunda llamada lo vuelve a poner ya limpio.
 *
 * Por eso se llama DOS VECES con la de Chat y UNA con la nuestra: en un estado
 * sano las tres no-op; en uno dañado, vacían el DOM y lo rehacen en el orden
 * del modelo.
 */
async function ensurePanesPresent(
  output: vscode.OutputChannel,
  chatViewId: string | undefined,
  fileLog?: FileLog,
): Promise<void> {
  const ensureVisible = (viewId: string) => ensureViewVisible(viewId, output, fileLog);

  if (chatViewId) {
    await ensureVisible(chatViewId);
    await ensureVisible(chatViewId);
  }
  await ensureVisible(STATUS_VIEW_ID);
}

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
 * P-040 — tras reescribir el modelo hay que reconstruir la pantalla; ver
 * `rebuildPanesOrder`. Es lo que separa "el modelo se movió" de "se ve movida".
 */
export async function restoreViewOrder(
  output: vscode.OutputChannel,
  state: vscode.Memento,
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
      `[place] focusedView := ${STATUS_VIEW_ID} vía setContext (directo en IContextKeyService; ` +
        `no depende de que el webview confirme el foco)`,
    );
  } else {
    trace(`[place] setContext/_setContext no disponibles → respaldo: ${STATUS_VIEW_ID}.focus + ${FOCUS_SETTLE} ms`);
  }

  let rejects = 0;
  let accepted = 0;
  const chatViewId = await discoverChatViewId();
  trace(
    chatViewId
      ? `[place] vista de Chat localizada: ${chatViewId}`
      : `[place] vista de Chat NO localizada → la reconstrucción de pantalla queda limitada a la nuestra`,
  );

  // P-040 — ANTES de mover nada: `views.moveViewDown` exige que la nuestra sea
  // visible, y además cualquier evento con índices cruzados retira el pane
  // equivocado. Este paso deja modelo y pantalla contando las mismas vistas.
  await ensurePanesPresent(output, chatViewId, fileLog);

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

    // P-040 — SIEMPRE, y no solo si el mandato fue aceptado: `moveViewDown`
    // reescribe el modelo y la pantalla no se entera, y la reconstrucción es
    // además lo que repara el estado que los refrescos anteriores dejaron
    // inconsistente (índices del modelo aplicados al array de panes).
    await rebuildPanesOrder(output, chatViewId, state, fileLog);
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
      `(en el borde son no-op, por eso el bucle es idempotente) → la vista queda la última del contenedor`,
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
