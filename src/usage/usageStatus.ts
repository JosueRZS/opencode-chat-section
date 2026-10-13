import * as vscode from "vscode";
import {
  USAGE_URL,
  WINDOW_ORDER,
  describeReset,
  httpFailure,
  isLimited,
  parseUsage,
  type UsageFailure,
  type UsageSnapshot,
  type WindowKey,
} from "./usageContract";

/**
 * Indicador de cuota de modelos en la barra de estado.
 *
 * Es lo único de esta extensión que sale a la red. Tres salvaguardas, de la más
 * dura a la más blanda:
 *
 *   1. Sin clave en el almacén secreto no se crea NADA — ni item, ni petición.
 *   2. `opencodeChat.usage.enabled = false` detiene el temporizador y oculta.
 *   3. Cada llamada va con tiempo máximo: un servicio caído no puede dejar el
 *      temporizador acumulando peticiones.
 *
 * El README lo declara explícitamente: el TUI sigue siendo puro PTY, y esto es
 * un añadido aparte que solo habla con `opencode.ai`.
 */

/** Clave en `SecretStorage`. Nunca en settings ni en un fichero plano. */
export const USAGE_SECRET_KEY = "opencode.usage.apiKey";

/** El servicio responde, pero nunca se cuelga la extensión esperándole. */
const REQUEST_TIMEOUT_MS = 15_000;

const MIN_INTERVAL_MINUTES = 5;

interface LastSuccess {
  snapshot: UsageSnapshot;
  at: Date;
}

export class UsageStatus implements vscode.Disposable {
  private readonly item: vscode.StatusBarItem;
  private timer: ReturnType<typeof setInterval> | undefined;
  private last: LastSuccess | undefined;
  private inFlight = false;
  /**
   * `SecretStorage.get` es asíncrono, así que comprobar la clave deja una
   * ventana en la que ya se puede haber dispensado. `refresh` la mira antes de
   * tocar el item.
   */
  private disposed = false;
  private readonly configWatcher: vscode.Disposable;

  constructor(
    private readonly secrets: vscode.SecretStorage,
    private readonly output: vscode.OutputChannel,
  ) {
    this.item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 98);
    // El nombre es lo que lee un lector de pantalla; va en el mismo idioma que
    // el resto de textos visibles.
    this.item.name = vscode.l10n.t("OpenCode usage");
    // Pulsar refresca: es la única acción con sentido para un indicador de cuota.
    this.item.command = "opencodeChat.usage.refresh";

    this.configWatcher = vscode.workspace.onDidChangeConfiguration(event => {
      if (event.affectsConfiguration("opencodeChat.usage")) {
        this.applySettings();
      }
    });
    this.applySettings();
  }

  dispose(): void {
    this.disposed = true;
    this.stop();
    this.configWatcher.dispose();
    this.item.dispose();
  }

  /** Lee ajustes y arranca o detiene en consecuencia. */
  private applySettings(): void {
    const config = vscode.workspace.getConfiguration("opencodeChat.usage");
    const enabled = config.get<boolean>("enabled", true);
    const minutes = Math.max(MIN_INTERVAL_MINUTES, config.get<number>("intervalMinutes", 15));

    if (!enabled) {
      this.stop();
      return;
    }
    // Solo produce efectos secundarios (mostrar el item, lanzar el temporizador),
    // así que no hace falta esperarla: se ignora el resultado a propósito.
    void this.start(minutes);
  }

  private async start(intervalMinutes: number): Promise<void> {
    this.stop();
    // Sin clave no hay nada que refrescar y no se crea ni un item: el indicador
    // no aparece, no aparece vacío, y sobre todo no se hace ninguna petición.
    if (!(await this.hasKey())) {
      return;
    }
    this.item.show();
    await this.refresh();
    if (this.disposed) {
      return;
    }
    this.timer = setInterval(() => void this.refresh(), intervalMinutes * 60_000);
  }

  private async hasKey(): Promise<boolean> {
    return Boolean(await this.secrets.get(USAGE_SECRET_KEY));
  }

  private stop(): void {
    if (this.timer !== undefined) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
    this.item.hide();
  }

  /** Guarda una clave nueva y refresca ya, sin esperar al temporizador. */
  async setApiKey(): Promise<void> {
    const value = await vscode.window.showInputBox({
      prompt: vscode.l10n.t("Paste the OpenCode API key. It is stored in the VS Code secret store."),
      password: true,
      ignoreFocusOut: true,
    });
    if (value === undefined) {
      return;
    }
    const key = value.trim();
    if (key.length === 0) {
      await this.clearApiKey();
      return;
    }
    await this.secrets.store(USAGE_SECRET_KEY, key);
    this.output.appendLine(`[usage] clave de uso guardada (${key.length} caracteres)`);
    void vscode.window.showInformationMessage(vscode.l10n.t("OpenCode: usage API key saved."));
    this.applySettings();
    await this.refresh();
  }

  /** Borra la clave y retira el indicador de la barra. */
  async clearApiKey(): Promise<void> {
    await this.secrets.delete(USAGE_SECRET_KEY);
    this.last = undefined;
    this.output.appendLine("[usage] clave de uso borrada");
    void vscode.window.showInformationMessage(vscode.l10n.t("OpenCode: usage API key cleared."));
    this.applySettings();
  }

  /** Descarga la cuota y la pinta. Seguro de llamar aunque ya haya una en vuelo. */
  async refresh(): Promise<void> {
    if (this.inFlight || this.disposed) {
      return;
    }
    const key = await this.secrets.get(USAGE_SECRET_KEY);
    // Dispuesto mientras se esperaba la clave: el item ya no existe.
    if (this.disposed) {
      return;
    }
    if (!key) {
      this.item.hide();
      return;
    }

    this.inFlight = true;
    try {
      const snapshot = await this.fetchUsage(key);
      if (snapshot && !this.disposed) {
        this.last = { snapshot, at: new Date() };
        this.paint(snapshot, isLimited(snapshot));
        this.item.tooltip = this.buildTooltip(snapshot);
        this.output.appendLine(
          `[usage] cuota: ${WINDOW_ORDER.map(k => `${k} ${snapshot[k].percent}%`).join(", ")}`,
        );
      }
    } finally {
      this.inFlight = false;
    }
  }

  private async fetchUsage(key: string): Promise<UsageSnapshot | undefined> {
    let response: Response;
    try {
      response = await fetch(USAGE_URL, {
        method: "GET",
        headers: {
          Authorization: `Bearer ${key}`,
          // Identifica al cliente sin decir nada del usuario.
          "x-opencode-session": "vscode-chat-section",
          "User-Agent": "opencode-chat-section",
        },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (error) {
      // Red caída, DNS o tiempo agotado: son el mismo caso para el usuario.
      this.renderFailure("network", error);
      return undefined;
    }

    const failure = httpFailure(response.status);
    if (failure) {
      this.renderFailure(failure);
      return undefined;
    }

    let payload: unknown;
    try {
      payload = await response.json();
    } catch (error) {
      this.renderFailure("invalid", error);
      return undefined;
    }

    const parsed = parseUsage(payload);
    if (!parsed.ok) {
      this.renderFailure(parsed.reason);
      return undefined;
    }
    return parsed.snapshot;
  }

  /**
   * Pinta un fallo sin perder lo último bueno: si ya había cuota, se siguen
   * viendo los números y solo cambia el fondo y el detalle. Borrar la cifra
   * porque un servicio fallara una vez empeoraría el dato, no lo corregiría.
   */
  private renderFailure(reason: UsageFailure, error?: unknown): void {
    this.output.appendLine(`[usage] fallo: ${reason}${error ? ` (${String(error)})` : ""}`);
    if (this.last) {
      this.paint(this.last.snapshot, true);
      this.item.tooltip = this.buildTooltip(this.last.snapshot, this.reasonText(reason));
      return;
    }
    this.item.text = "$(warning) OpenCode";
    this.item.backgroundColor = new vscode.ThemeColor("statusBarItem.warningBackground");
    this.item.tooltip = this.reasonText(reason);
  }

  private paint(snapshot: UsageSnapshot, warning: boolean): void {
    const percents = WINDOW_ORDER.map(key => `${snapshot[key].percent}%`).join(" · ");
    this.item.text = `$(opencode) ${percents}`;
    this.item.backgroundColor = warning ? new vscode.ThemeColor("statusBarItem.warningBackground") : undefined;
  }

  private buildTooltip(snapshot: UsageSnapshot, note?: string): vscode.MarkdownString {
    const md = new vscode.MarkdownString();
    md.supportThemeIcons = true;
    // Sin isTrusted: no hay enlaces de mandato, así que el markdown queda a la
    // defensiva y un nombre de ventana inyectado no podría ejecutar nada.
    md.appendMarkdown(`### ${vscode.l10n.t("OpenCode usage")}\n\n`);
    const headers = [
      vscode.l10n.t("Window"),
      vscode.l10n.t("Used"),
      vscode.l10n.t("Status"),
      vscode.l10n.t("Resets"),
    ];
    md.appendMarkdown(`| ${headers.join(" | ")} |\n|:---|---:|:---:|:---|\n`);
    for (const key of WINDOW_ORDER) {
      const window = snapshot[key];
      const status = window.limited ? vscode.l10n.t("Rate limited") : vscode.l10n.t("OK");
      md.appendMarkdown(
        `| **${this.windowLabel(key)}** | ${window.percent}% | ${status} | ${this.resetLabel(window.resetsAt)} |\n`,
      );
    }
    if (note) {
      md.appendMarkdown(`\n${note}\n`);
    }
    md.appendMarkdown(`\n---\n_${vscode.l10n.t("Updated at {0}. Click to refresh.", this.clockOf(this.last?.at))}_\n`);
    return md;
  }

  /**
   * `rolling` es una ventana deslizante de 5 horas. Llamarla «diario» haría
   * creer al usuario que se renueva una vez al día cuando no es así.
   */
  private windowLabel(key: WindowKey): string {
    if (key === "rolling") {
      return vscode.l10n.t("5 h rolling");
    }
    if (key === "weekly") {
      return vscode.l10n.t("Weekly");
    }
    return vscode.l10n.t("Monthly");
  }

  private resetLabel(resetsAt: string | undefined): string {
    const reset = describeReset(resetsAt, Date.now());
    if (reset === undefined) {
      return "-";
    }
    if (reset.kind === "now") {
      return vscode.l10n.t("now");
    }
    if (reset.kind === "raw") {
      return reset.value;
    }
    if (reset.kind === "min") {
      return vscode.l10n.t("in {0} min", reset.value);
    }
    if (reset.kind === "h") {
      return vscode.l10n.t("in {0} h", reset.value);
    }
    return vscode.l10n.t("in {0} d", reset.value);
  }

  private reasonText(reason: UsageFailure): string {
    if (reason === "unauthorized") {
      return vscode.l10n.t("OpenCode: the API key was rejected. Set a new one from the Command Palette.");
    }
    if (reason === "no-subscription") {
      return vscode.l10n.t("OpenCode: this account has no active subscription.");
    }
    if (reason === "network") {
      return vscode.l10n.t("OpenCode: usage could not be fetched (network error).");
    }
    return vscode.l10n.t("OpenCode: the usage response was not understood.");
  }

  private clockOf(at: Date | undefined): string {
    return (at ?? new Date()).toLocaleTimeString();
  }
}
