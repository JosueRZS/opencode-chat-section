import * as vscode from "vscode";
import { OpenCodePty } from "./terminal/OpenCodePty";
import { TuiViewProvider } from "./views/TuiView";
import { sendSelection } from "./commands/context";
import {
  restoreTerminalView,
  ensureStatusViewInChat,
  ensureStatusViewVisible,
  restoreViewOrder,
} from "./utils/placement";
import { FileLog } from "./utils/filelog";
import { stamp } from "./utils/log";
import { UsageStatus } from "./usage/usageStatus";

// Attribution (§0.4): patrón de terminal + sendText(x, false) tomado de la
// extensión oficial de OpenCode (`anomalyco/opencode/sdks/vscode`, MIT).

let pty: OpenCodePty | undefined;
let view: TuiViewProvider | undefined;

export function activate(context: vscode.ExtensionContext): void {
  const output = vscode.window.createOutputChannel("OpenCode Chat");
  // P-025: log a fichero con escritura síncrona. El OutputChannel de VS Code es
  // asíncrono y vive en el extension host: si el host se cuelga (P-024 causa 3),
  // las últimas líneas se pierden. Este log sobrevive.
  const fileLog = new FileLog("opencode-chat.log");
  fileLog.write(`=== extension activada (pid ${process.pid}) ===`);
  // La Salida estándar (View → Output → "OpenCode Chat") es el canal público;
  // el fichero es el respaldo que sobrevive si el host se cuelga.
  output.appendLine(`${stamp()} [activate] extension activada (pid ${process.pid})`);
  output.appendLine(`${stamp()} [activate] log de respaldo: ${fileLog.path}`);

  pty = new OpenCodePty(output, fileLog);
  view = new TuiViewProvider(context, pty, output, fileLog);
  context.subscriptions.push(output, pty, view);

  // --- Indicador de cuota de modelos (barra de estado) ---
  // Aparte del TUI: solo esta clase habla con la red, y no lo hace en absoluto
  // mientras el CLI no tenga una credencial que ofrecer. Ver `UsageStatus`.
  const usage = new UsageStatus(output);
  context.subscriptions.push(usage);

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

  // El proveedor va ANTES del `moveViews`: mover la vista antes de haberla
  // declarado obliga al workbench a reconstruirla, y cada reconstrucción es una
  // oportunidad de perder el canal de mensajes webview↔extensión (P-026).
  // P-041/P-042: después del movimiento se asegura que la sección esté visible
  // — el modelo persiste `isHidden` y el arranque lo reproduce sin más. Solo si
  // el contenedor de Chat ya está, porque `openView` necesita el contenedor.
  void ensureStatusViewInChat(output, context.globalState, fileLog).then(where => {
    if (where === "ok") {
      return ensureStatusViewVisible(output, context.globalState, fileLog);
    }
    return undefined;
  });
  void restoreTerminalView(output, context.globalState, fileLog);
  output.appendLine(`${stamp()} [activate] extension activada (webview+pty)`);

  // --- Comandos (Fase 1: launch / focus / newSession / sendSelection) ---
  context.subscriptions.push(
    vscode.commands.registerCommand("opencodeChat.launch", () => {
      fileLog.write("[cmd] opencodeChat.launch ejecutado");
      pty?.launch();
    }),
    vscode.commands.registerCommand("opencodeChat.focus", () => view?.focus()),
    vscode.commands.registerCommand("opencodeChat.newSession", () => pty?.newSession()),
    vscode.commands.registerCommand("opencodeChat.sendSelection", async () => {
      if (!pty) {
        return;
      }
      // T7: la referencia se inyecta SIN Enter ⇒ hay que verla en el compositor.
      const sent = await sendSelection(pty);
      if (sent) {
        view?.focus();
      }
    }),
    // P-025: el canal de Salida estándar (View → Output → "OpenCode Chat"),
    // que es como diagnostica cualquier otra extensión.
    vscode.commands.registerCommand("opencodeChat.showOutput", () =>
      output.show(true),
    ),
    // Fase 4 (P-032): un solo atajo que muestra/oculta Chat y OpenCode a la vez.
    vscode.commands.registerCommand("opencodeChat.toggle", () => toggleChatAndOpenCode(view, output, fileLog)),
    // P-034: devuelve la sección a su sitio si el usuario la arrastra a otro.
    // Es la MISMA rutina que corre al activar: no hay un segundo camino que
    // pueda divergir del comportamiento normal.
    vscode.commands.registerCommand("opencodeChat.restorePosition", async () => {
      fileLog.write("[cmd] opencodeChat.restorePosition ejecutado");

      // Paso 1 — contenedor: la sección debe vivir en el de Chat.
      const where = await ensureStatusViewInChat(output, context.globalState, fileLog);
      if (where !== "ok") {
        if (where === "chat-not-loaded") {
          void vscode.window.showWarningMessage(
            vscode.l10n.t("OpenCode: Chat has not loaded yet; try again in a few seconds."),
          );
        } else {
          void vscode.window.showErrorMessage(
            vscode.l10n.t('OpenCode: the section could not be moved. See View → Output → "OpenCode Chat".'),
          );
        }
        return;
      }

      // Paso 2 — orden: esto es lo que P-034 no hacía. `vscode.moveViews` es
      // no-op si la vista ya está en el contenedor, así que una sección
      // arrastrada por encima de Chat seguía arriba mientras el aviso afirmaba
      // lo contrario. Aquí se reescribe `state.order` de verdad.
      const order = await restoreViewOrder(output, fileLog);
      if (order === "no-focus") {
        void vscode.window.showErrorMessage(
          vscode.l10n.t(
            'OpenCode: the section is in the container but could not be reordered. See View → Output → "OpenCode Chat".',
          ),
        );
        return;
      }

      // Presente, no pasado: si ya estaba debajo no se ve ningún cambio, y este
      // aviso es lo único que confirma que los dos mandatos corrieron. Se avisa
      // además de que el ORDEN VISIBLE solo se aplica al reconstruirse el
      // contenedor: reescribir el modelo sí es inmediato, pintarlo no (P-043).
      void vscode.window.showInformationMessage(vscode.l10n.t("OpenCode: position restored. If you had dragged the section, reload the window to see the new order."));
    }),
    // --- Cuota de modelos: refresco. La credencial es la del CLI, y solo esa ---
    // El refresco explícito descarta también la memoización del CLI, así que
    // «Actualizar» vuelve a leer la credencial y no solo la cuota.
    vscode.commands.registerCommand("opencodeChat.usage.refresh", () => {
      usage.invalidateCredential();
      return usage.refresh();
    }),
  );

  // --- Ciclo de vida (§7.3) — la señal es `onExit` de la PTY ---
  // Sin `onDidEndTerminalShellExecution` (P-016): no hay terminal de VS Code.
  // `chainExit` hace que la PTY muera con el TUI ⇒ se vuelve al botón Launch.
  output.appendLine(`${stamp()} [activate] ciclo de vida: PTY onExit`);
}

export function deactivate(): void {
  pty?.dispose();
}

/**
 * Fase 4 (P-032) — Un solo atajo que muestra/oculta Chat y OpenCode a la vez.
 *
 * Las dos vistas viven en la Secondary Side Bar, así que la vía robusta es
 * alternar esa barra entera (`workbench.action.toggleAuxiliaryBar`, verificado
 * presente en el workbench de 1.141). No se mueven vistas ni se toca la
 * visibilidad individual de ninguna: eso es exactamente lo que en P-017 acabó
 * subiendo la shell del usuario a la barra lateral.
 *
 * El único matiz es a dónde va el foco. `toggleAuxiliaryBar` es un alternador
 * ciego: invierte sin preguntar. Por eso el estado se lee DESPUÉS, no antes.
 * Mirándolo antes, una sección colapsada dentro de una barra visible contaría
 * como "oculta"; al alternar la barra (que la OCULTA) acabaríamos enfocándola,
 * con lo que la devolveríamos a la vista y el atajo haría lo contrario de lo
 * que se pidió.
 */
async function toggleChatAndOpenCode(
  view: TuiViewProvider | undefined,
  output: vscode.OutputChannel,
  fileLog: FileLog,
): Promise<void> {
  const before = view?.isVisible ?? false;
  fileLog.write(`[toggle] antes: visible=${before}`);

  const commands = await vscode.commands.getCommands(true);
  if (!commands.includes("workbench.action.toggleAuxiliaryBar")) {
    output.appendLine(`${stamp()} [toggle] workbench.action.toggleAuxiliaryBar no disponible`);
    fileLog.write("[toggle] comando del workbench ausente");
    return;
  }

  await vscode.commands.executeCommand("workbench.action.toggleAuxiliaryBar");
  const after = await settleVisibility(view);
  fileLog.write(`[toggle] despues: visible=${after}`);

  // Solo al MOSTRAR se enfoca. Si acabamos de ocultar, enfocarla la revelaría.
  if (after) {
    view?.focus();
  }
}

/**
 * Espera a que la visibilidad del webview se asiente tras alternar la barra.
 * El workbench lo aplica al vuelo, pero el webview puede tardar un turno en
 * reportarlo: se muestrea cada 30 ms y se devuelve al estabilizarse, con un
 * tope para que un fallo inesperado deje el atajo funcionando igualmente.
 */
async function settleVisibility(view: TuiViewProvider | undefined): Promise<boolean> {
  const deadline = Date.now() + 400;
  await new Promise<void>(r => setTimeout(r, 50));
  let previous = view?.isVisible ?? false;
  while (Date.now() < deadline) {
    await new Promise<void>(r => setTimeout(r, 30));
    const current = view?.isVisible ?? false;
    if (current === previous) {
      return current;
    }
    previous = current;
  }
  return view?.isVisible ?? false;
}
