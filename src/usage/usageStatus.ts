import * as vscode from "vscode";
import { readCliCredential } from "./cliCredential";
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
 *   1. Sin ninguna fuente de credencial no se crea NADA — ni item, ni petición.
 *   2. `opencodeChat.usage.enabled = false` detiene el temporizador y oculta.
 *   3. Cada llamada va con tiempo máximo: un servicio caído no puede dejar el
 *      temporizador acumulando peticiones.
 *
 * La credencial NO se pide al usuario: se lee la que el propio CLI ya tiene
 * guardada (`opencode auth export`). La clave manual de `SecretStorage` existe
 * solo como respaldo para cuando el CLI no está disponible.
 *
 * El README lo declara explícitamente: el TUI sigue siendo puro PTY, y esto es
 * un añadido aparte que solo habla con `opencode.ai`.
 */

/** Respaldo manual. Casi nunca se usa: lo normal es que mande el CLI. */
export const USAGE_SECRET_KEY = "opencode.usage.apiKey";

/** El servicio responde, pero nunca se cuelga la extensión esperándole. */
const REQUEST_TIMEOUT_MS = 15_000;

const MIN_INTERVAL_MINUTES = 5;

/**
 * Cuánto se reutiliza la credencial leída del CLI. Un refresco puede costar
 * ~750 ms por el arranque del proceso, así que `start()` y un refresco manual
 * seguidos no deben pagarlo dos veces. La caducidad permite recoger un
 * `opencode auth login` hecho mientras la extensión estaba corriendo.
 */
const CLI_CREDENTIAL_TTL_MS = 5 * 60_000;

/** De dónde salió la clave que se está usando. Se registra para que nunca haya duda. */
type CredentialSource = "cli" | "manual";

interface Credential {
  key: string;
  source: CredentialSource;
}

interface LastSuccess {
  snapshot: UsageSnapshot;
  at: Date;
}

type FetchOutcome =
  | { ok: true; snapshot: UsageSnapshot }
  | { ok: false; reason: UsageFailure };

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
  /** Credencial del CLI memoizada; ver `CLI_CREDENTIAL_TTL_MS`. */
  private cliCredentialCache: { key: string | undefined; at: number } | undefined;

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
    // Sin ninguna fuente de credencial no hay nada que refrescar y no se crea
    // ni un item: el indicador no aparece, no aparece vacío, y sobre todo no se
    // hace ninguna petición.
    if (!(await this.hasCredential())) {
      return;
    }
    this.item.show();
    await this.refresh();
    if (this.disposed) {
      return;
    }
    this.timer = setInterval(() => void this.refresh(), intervalMinutes * 60_000);
  }

  private async hasCredential(): Promise<boolean> {
    if (await this.secrets.get(USAGE_SECRET_KEY)) {
      return true;
    }
    return (await this.credential("cli")) !== undefined;
  }

  /**
   * Lee la credencial del CLI, memoizada.
   *
   * No se propaga ningún error: si el CLI no está instalado, no está
   * autenticado o la ruta es insegura para el shell, devuelve `undefined` y la
   * cadena de fuentes sigue con la clave manual.
   */
  private async credential(source: CredentialSource, force = false): Promise<Credential | undefined> {
    if (source === "manual") {
      const key = await this.secrets.get(USAGE_SECRET_KEY);
      return key ? { key, source } : undefined;
    }

    const cliPath =
      vscode.workspace.getConfiguration("opencodeChat").get<string>("cliPath", "opencode") || "opencode";
    const cached = this.cliCredentialCache;
    if (!force && cached && Date.now() - cached.at < CLI_CREDENTIAL_TTL_MS) {
      return cached.key ? { key: cached.key, source } : undefined;
    }
    const key = await readCliCredential(cliPath);
    this.cliCredentialCache = { key, at: Date.now() };
    return key ? { key, source } : undefined;
  }

  /**
   * Fuentes en orden: primero la del CLI —que es la que el usuario quiere que
   * mande y la que evita reconfigurar nada— y después la clave manual, que solo
   * importa cuando el CLI no aporta ninguna.
   */
  private async credentialCandidates(): Promise<Credential[]> {
    const candidates: Credential[] = [];
    const cli = await this.credential("cli");
    if (cli) {
      candidates.push(cli);
    }
    const manual = await this.credential("manual");
    if (manual && manual.key !== cli?.key) {
      candidates.push(manual);
    }
    return candidates;
  }

  /** Descarta la memoización: lo pide el refresco explícito del usuario. */
  invalidateCredential(): void {
    this.cliCredentialCache = undefined;
  }

  private stop(): void {
    if (this.timer !== undefined) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
    this.item.hide();
  }

  /**
   * Guarda la clave de RESPALDO. Casi nunca hace falta: el CLI ya aporta la suya
   * y esa manda. Solo se usa cuando el CLI no está disponible.
   */
  async setApiKey(): Promise<void> {
    const value = await vscode.window.showInputBox({
      prompt: vscode.l10n.t("Optional fallback: the key the OpenCode CLI already has is used first. Only set one if the CLI is unavailable."),
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
    this.inFlight = true;
    try {
      const candidates = await this.credentialCandidates();
      // Dispuesto mientras se esperaba la credencial: el item ya no existe.
      if (this.disposed) {
        return;
      }
      if (candidates.length === 0) {
        this.item.hide();
        return;
      }

      // Se prueban en orden hasta que una dé dato. Un fallo de red o de parseo
      // corta la cadena: no lo arregla otra clave, y repetir solo alargaría.
      let outcome: FetchOutcome | undefined;
      let used: CredentialSource | undefined;
      for (const candidate of candidates) {
        outcome = await this.fetchUsage(candidate.key);
        if (outcome.ok) {
          used = candidate.source;
          break;
        }
        if (outcome.reason === "network" || outcome.reason === "invalid") {
          break;
        }
      }
      if (this.disposed || !outcome) {
        return;
      }

      if (outcome.ok) {
        const snapshot = outcome.snapshot;
        this.last = { snapshot, at: new Date() };
        this.paint(snapshot, isLimited(snapshot));
        this.item.tooltip = this.buildTooltip(snapshot);
        // La fuente se registra a propósito: si el CLI y la clave manual
        // difieren, hace falta saber cuál está mandando.
        this.output.appendLine(
          `[usage] credencial ${used} | ${WINDOW_ORDER.map(k => `${k} ${snapshot[k].percent}%`).join(", ")}`,
        );
        return;
      }
      this.renderFailure(outcome.reason);
    } finally {
      this.inFlight = false;
    }
  }

  private async fetchUsage(key: string): Promise<FetchOutcome> {
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
      this.logFailure("network", error);
      return { ok: false, reason: "network" };
    }

    const failure = httpFailure(response.status);
    if (failure) {
      this.logFailure(failure);
      return { ok: false, reason: failure };
    }

    let payload: unknown;
    try {
      payload = await response.json();
    } catch (error) {
      this.logFailure("invalid", error);
      return { ok: false, reason: "invalid" };
    }

    const parsed = parseUsage(payload);
    if (!parsed.ok) {
      this.logFailure(parsed.reason);
      return { ok: false, reason: parsed.reason };
    }
    return { ok: true, snapshot: parsed.snapshot };
  }

  private logFailure(reason: UsageFailure, error?: unknown): void {
    this.output.appendLine(`[usage] fallo: ${reason}${error ? ` (${String(error)})` : ""}`);
  }

  /**
   * Pinta un fallo sin perder lo último bueno: si ya había cuota, se siguen
   * viendo los números y solo cambia el fondo y el detalle. Borrar la cifra
   * porque un servicio fallara una vez empeoraría el dato, no lo corregiría.
   */
  private renderFailure(reason: UsageFailure): void {
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
    const percents = WINDOW_ORDER.map(key => `${snapshot[key].percent}%`).join(" | ");
    this.item.text = `$(opencode-logo) ${percents}`;
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
   * Etiqueta de cada ventana del indicador.
   *
   * `rolling` es una ventana DESLIZANTE de 5 horas: no se renueva a medianoche
   * ni una vez al día, así que llamarla «diario» habría mentido sobre cuándo se
   * recupera cuota. «Uso continuo» describe lo que de verdad es —un consumo
   * medido sobre las últimas 5 horas— sin prometer un periodo concreto.
   */
  private windowLabel(key: WindowKey): string {
    if (key === "rolling") {
      return vscode.l10n.t("Rolling usage");
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
    if (reset.kind === "duration") {
      return reset.hours > 0
        ? vscode.l10n.t("{0}h {1}m", reset.hours, reset.minutes)
        : vscode.l10n.t("{0}m", reset.minutes);
    }
    return reset.hours > 0
      ? vscode.l10n.t("{0}d {1}h", reset.days, reset.hours)
      : vscode.l10n.t("{0}d", reset.days);
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
