import * as vscode from "vscode";
import * as path from "path";
import {
  buildOpencodeCommand,
  envWithPath,
  opencodeTuiEnv,
  resolveCwd,
  resolveShell,
} from "../utils/shell";
import { STATUS_VIEW_ID } from "../utils/placement";
import { stamp } from "../utils/log";
import {
  ensureOpencodeAvailable,
  type GuardResult,
  type InstallOffer,
} from "../utils/opencodeInstall";
import type { FileLog } from "../utils/filelog";
import { PtyHostClient } from "./PtyHostClient";

/**
 * La instancia efímera de OpenCode (D1) sobre una **PTY real**.
 *
 * Por qué PTY y no `vscode.window.createTerminal` (P-022): un terminal de VS Code
 * solo puede vivir en el Panel o en un Editor (P-017) — **nunca dentro de una vista**.
 * Para que el TUI se renderice DENTRO de la sección OpenCode (debajo de Chat) hay que
 * alojarlo en un WebviewView con xterm.js, y eso exige una PTY propia.
 *
 * **P-027 — la PTY NO corre aquí, sino en un proceso hijo** (`dist/pty-host.cjs`):
 * dentro del extension host, `node-pty.spawn()` se bloqueaba para siempre (hereda
 * el `execArgv` de Electron en el worker de ConPTY) y congelaba la ventana entera.
 * El cliente (`PtyHostClient`) además pone plazo a cada paso ⇒ un cuelgue se
 * convierte en un mensaje de error recuperable, nunca en una congelación.
 *
 * El shell se arranca igual que antes (P-001): nunca `spawn('opencode')` a pelo, porque el
 * PATH del extension host no es el del usuario; se teclea el comando dentro del shell, que
 * sí resuelve `opencode` igual que en una terminal normal.
 */
export class OpenCodePty implements vscode.Disposable {
  private running = false;
  /** Fase 3: ya se está comprobando/instalando ⇒ no lanzar dos veces (P-031). */
  private preparing = false;
  /**
   * P-044 — cómo se pregunta «¿instalarlo?». La respuesta la da la SECCIÓN
   * (su propio panel), no un diálogo del editor, así que el PTY no puede
   * preguntar por sí solo: la vista se lo inyecta al construirse.
   *
   * Si aún no hay vista —o se está recreando— no se pregunta y la guardia
   * devuelve `blocked`; la sección acabará en el botón Launch.
   */
  private installAsker: ((offer: InstallOffer) => Promise<boolean>) | undefined;
  /**
   * P-044 — ¿la guardia ya se pronunció sobre un OpenCode que faltaba?
   *
   * Una vez contestada la pregunta —o una vez saltada por decisión del
   * usuario— Launch deja de consultar la guardia y lanza de verdad. Sin esto
   * habría dos callejones: volver a preguntar en cada pulsación, o quedarse
   * re-probando sin hacer nada visible. Si OpenCode sigue sin estar, que sea el
   * shell de la sección el que lo diga: es la verdad y es accionable.
   *
   * `false` al inicio de cada sesión de editor; la guardia que encuentra el CLI
   * no lo asienta, para que un `opencode` instalado a mano después sí se note.
   */
  private installSettled = false;
  private pid: number | undefined;

  private readonly stateEmitter = new vscode.EventEmitter<void>();
  private readonly dataEmitter = new vscode.EventEmitter<string>();
  private readonly statusEmitter = new vscode.EventEmitter<{ phase: string; detail: string }>();

  /** Se dispara al crear/matar la PTY (para la vista). */
  readonly onDidChangeState = this.stateEmitter.event;
  /** Salida cruda de la PTY, para reenviarla a xterm.js. */
  readonly onDidReceiveData = this.dataEmitter.event;
  /** P-025: cambio de fase (`idle` | `starting` | `running` | `exited` | `error`). */
  readonly onDidChangeStatus = this.statusEmitter.event;

  /**
   * Reemplazo del stdout perdido: con `retainContextWhenHidden` el webview persiste,
   * pero al ABRIR la vista por primera vez con la TUI ya corriendo hay que repintar.
   */
  private replay = "";
  private static readonly MAX_REPLAY = 512 * 1024;
  private totalBytes = 0;

  /** P-024: si el TUI muere, la PTY debe morir con él (§7.3 `chainExit`). */
  private chainExit = true;
  /** P-027: si tras el spawn no llega ni un byte, decirlo (nunca un "cargando" mudo). */
  private firstDataTimer: ReturnType<typeof setTimeout> | undefined;
  /** Comando a tecleear en el shell en cuanto la PTY confirme el arranque. */
  private pendingCommand = "";

  /**
   * P-033 — Detección del fin de sesión por **alternate screen**, no por texto.
   *
   * `watchPrompt()` decidía que "vuelve el prompt del shell" con `/[>]\s*$/`
   * sobre todo el buffer acumulado. Un TUI imprime `>` a cada instante, así que
   * se armaba a los 1,5 s del arranque (medido) y disparaba `exit` mientras
   * OpenCode seguía vivo: el comando quedaba encolado en el shell y se aplicaba
   * después, cuando le daba la gana. El log lo confirma — `exit code=` aparece
   * **0 veces** en todo el historial: `onPtyExit` nunca corrió.
   *
   * La señal correcta es de protocolo, no de texto. Una TUI a pantalla completa
   * entra en alternate screen con `ESC[?1049h` al arrancar y lo **restaura**
   * con `ESC[?1049l` al salir. Medido contra OpenCode 2.0.26 real:
   *  - `1049h` aparece a t+1,8 s (arranque);
   *  - `1049l` aparece **0,1 s** tras teclear `/exit`;
   *  - en 30 s de control sin tocar nada, `1049l` **no aparece nunca**.
   * Por eso `altActive` exige haber visto `1049h` antes: un `1049l` suelto
   * sin sesión en pantalla no significa nada.
   */
  private altActive = false;
  /** Últimos bytes del chunk anterior: `ESC[?1049h/l` puede partirse entre dos. */
  private scanTail = "";
  /** Evita programar dos muertes de la PTY para el mismo fin de sesión. */
  private exitScheduled = false;
  /** Tras `1049l` se espera a que la TUI restaure la pantalla antes de matar. */
  private exitTimer: ReturnType<typeof setTimeout> | undefined;
  /** P-033: el usuario pidió lanzar mientras la PTY anterior aún se cerraba. */
  private pendingLaunch = false;

  private readonly subs: vscode.Disposable[] = [];
  private readonly client: PtyHostClient;

  constructor(
    private readonly output: vscode.OutputChannel,
    private readonly fileLog?: FileLog,
  ) {
    // `__dirname` = <ext>/dist ⇒ el host del hijo vive al lado del bundle.
    this.client = new PtyHostClient(
      path.join(__dirname, "pty-host.cjs"),
      path.dirname(__dirname),
    );

    this.subs.push(
      this.client.onDidBoot(b =>
        this.trace(
          "[pty-host]",
          `proceso hijo listo: pid=${b.pid} execArgv=${JSON.stringify(b.execArgv)}`,
        ),
      ),
      this.client.onDidSpawn(e => this.onPtySpawned(e.pid)),
      this.client.onDidReceiveData(d => this.onPtyData(d)),
      this.client.onDidExit(e => this.onPtyExit(e.exitCode, e.signal)),
      this.client.onError(m => {
        this.trace("[pty-host]", m);
        this.setStatus("error", m);
      }),
    );
  }

  /** PID del shell alojado en el hijo (útil en el diagnóstico). */
  get ptyPid(): number | undefined {
    return this.pid;
  }

  get isRunning(): boolean {
    return this.running;
  }

  /** Salida acumulada desde el arranque (para repintar el webview al abrirlo). */
  get replayBuffer(): string {
    return this.replay;
  }

  /** P-025: traza a AMBOS destinos (OutputChannel + fichero síncrono). */
  private trace(tag: string, msg: string): void {
    this.output.appendLine(`${stamp()} ${tag} ${msg}`);
    this.fileLog?.write(`${tag} ${msg}`);
  }

  private setStatus(phase: string, detail: string): void {
    this.fileLog?.write(`STATUS ${phase} :: ${detail}`);
    this.statusEmitter.fire({ phase, detail });
  }

  /**
   * §1.1 + §4: lanza OpenCode dentro de una PTY. Si ya corre, no hace nada
   * (una sola instancia, §7.4) — el foco lo resuelve `focus()`.
   *
   * **Fase 3 (P-031)**: antes de arrancar se comprueba que `opencode` exista; si no,
   * se ofrece instalarlo. El arranque se aplaza SOLO mientras dura esa guardía
   * (comprobación + modal + instalación), que puede tardar minutos. Es asincrónico
   * y con `preparing` para que un segundo lanzamiento no duplique el arranque.
   */
  launch(): void {
    if (this.running) {
      // P-033: si la TUI ya salió y la PTY se está cerrando, el usuario puede
      // pulsar Launch durante ese hueco. `running` sigue true, así que sin esto
      // el lanzamiento se descartaría en silencio y el botón volvería a
      // aparecer sin haber hecho nada.
      if (this.exitScheduled) {
        this.pendingLaunch = true;
        this.trace("[launch]", "la PTY anterior se esta cerrando -> lanzamiento aplazado");
        return;
      }
      this.setStatus("running", "ya hay una instancia en marcha");
      return;
    }
    if (this.preparing) {
      this.trace("[launch]", "ignorado: ya se esta comprobando/instalando");
      return;
    }

    this.preparing = true;
    void this.ensureAndLaunch();
  }

  /** P-044: la vista inyecta aquí cómo preguntar «¿instalarlo?» dentro de la sección. */
  setInstallAsker(ask: (offer: InstallOffer) => Promise<boolean>): void {
    this.installAsker = ask;
  }

  private async ensureAndLaunch(): Promise<void> {
    // P-044 — La guardia sólo se consulta mientras no se haya pronunciado.
    if (this.installSettled) {
      this.preparing = false;
      this.doLaunch();
      return;
    }

    let outcome: GuardResult["outcome"] = "available";
    let error = "";
    try {
      const guard = await ensureOpencodeAvailable(
        this.output,
        this.fileLog,
        (phase, detail) => this.setStatus(phase, detail),
        this.installAsker,
      );
      outcome = guard.outcome;
      error = guard.error;
      // Sólo `blocked`: si el CLI estaba, la próxima pulsación vuelve a
      // comprobarlo, así que un `opencode` instalado a mano sí se detecta.
      this.installSettled = guard.outcome === "blocked";
    } catch (e) {
      // La guardía nunca debe impedir el arranque: se lanza igualmente (P-028).
      this.trace(
        "[install]",
        `guardia de instalacion fallo: ${e instanceof Error ? e.message : String(e)} - se lanza igualmente`,
      );
    } finally {
      this.preparing = false;
    }

    // El usuario pudo lanzar manualmente mientras esperábamos.
    if (this.running) {
      return;
    }

    // P-044 — si la guardia tuvo que intervenir, NO se autoarranca: la sección
    // vuelve al botón Launch. Arrancar en silencio algo que acabamos de decirle
    // al usuario que faltaba sería ignorar lo que acaba de contestar.
    if (outcome === "blocked") {
      this.setStatus(error ? "error" : "awaiting-launch", error);
      return;
    }
    this.doLaunch();
  }

  /** El arranque propiamente dicho: la PTY con el comando de OpenCode. */
  private doLaunch(): void {
    const cfg = vscode.workspace.getConfiguration("opencodeChat");
    this.chainExit = cfg.get<boolean>("chainExit", true);
    const useConptyDll = cfg.get<boolean>("useConptyDll", true);
    const spawnTimeout = cfg.get<number>("ptySpawnTimeout", 10000);
    const shell = resolveShell();
    const cwd = resolveCwd(cfg.get<string>("terminalCwd"));
    const command = buildOpencodeCommand(this.chainExit);

    this.pendingCommand = command;
    this.replay = "";
    this.totalBytes = 0;
    // P-033: cada sesión empieza con el escáner limpio, o un `1049l` heredado
    // de la anterior mataría la nueva antes de que arrancara.
    this.altActive = false;
    this.scanTail = "";
    this.exitScheduled = false;

    this.trace(
      "[launch]",
      `shell=${shell.file} args=${JSON.stringify(shell.args)} cmd=${JSON.stringify(command)} cwd=${cwd ?? "(default)"} chain=${this.chainExit} conptyDll=${useConptyDll} timeout=${spawnTimeout}ms tui=${JSON.stringify(opencodeTuiEnv())}`,
    );
    this.setStatus("starting", "arrancando el proceso PTY...");

    this.client.launch(
      {
        file: shell.file,
        args: shell.args,
        cwd,
        // `envWithPath()` da el PATH (P-001); `opencodeTuiEnv()` añade el override
        // de la TUI solo para esta terminal (P-030).
        env: { ...envWithPath(), ...opencodeTuiEnv() },
        cols: 80,
        rows: 24,
        useConpty: process.platform === "win32",
        useConptyDll,
      },
      spawnTimeout,
    );

    this.stateEmitter.fire();
  }

  /** La PTY existe de verdad: ahora sí se teclea el comando (P-001/P-024). */
  private onPtySpawned(pid: number): void {
    this.running = true;
    this.pid = pid;
    this.trace("[pty]", `PTY creada (pid ${pid}); tecleando comando...`);
    this.setStatus("starting", `PTY creada (pid ${pid}), esperando la salida del shell...`);

    // P-027: si en3 s no llega ni un byte, decirlo en la barra de estado.
    this.firstDataTimer = setTimeout(() => {
      if (this.running && this.totalBytes === 0) {
        this.trace("[pty]", `spawn OK (pid ${pid}) pero sin salida tras 3 s`);
        this.setStatus("starting", `spawn correcto (pid ${pid}) pero la PTY aun no manda salida...`);
      }
    }, 3000);

    this.writeCommand(this.pendingCommand);
    this.stateEmitter.fire();
  }

  private onPtyData(d: string): void {
    const first = this.totalBytes === 0;
    this.totalBytes += d.length;
    this.replay += d;
    if (this.replay.length > OpenCodePty.MAX_REPLAY) {
      this.replay = this.replay.slice(-OpenCodePty.MAX_REPLAY);
    }
    if (first) {
      if (this.firstDataTimer) {
        clearTimeout(this.firstDataTimer);
        this.firstDataTimer = undefined;
      }
      this.trace("[pty]", `primer bloque de salida: ${d.length} B`);
      this.setStatus("running", `shell activo, ${d.length} B recibidos`);
    }
    this.scanAltScreen(d);
    this.dataEmitter.fire(d);
  }

  /**
   * P-033 — Busca `ESC[?1049h` (la TUI ocupa la pantalla) y `ESC[?1049l`
   * (la restaura al salir). Sustituye a la heurística de prompt.
   *
   * Se concatenan los últimos bytes del chunk anterior: ConPTY trocea la salida
   * y la secuencia de 6 caracteres puede partirse entre dos `onData`.
   *
   * `1049l` solo se atiende si `altActive` es cierto, es decir, si antes hubo
   * `1049h`: un `1049l` sin sesión previa no es un fin de sesión.
   */
  private scanAltScreen(d: string): void {
    const hay = this.scanTail + d;
    if (hay.includes("\u001b[?1049h")) {
      this.altActive = true;
      this.trace("[pty]", "TUI entro en alternate screen (ESC[?1049h)");
    }
    if (this.altActive && hay.includes("\u001b[?1049l")) {
      this.altActive = false;
      this.onTuiLeftScreen();
    }
    this.scanTail = hay.slice(-8);
  }

  /**
   * P-033 — La TUI terminó: el TUI devolvió el control al shell.
   *
   * Se espera un instante a que la TUI restaure la pantalla (entre `1049l` y
   * el prompt pasan apenas milisegundos, pero matarla antes dejaría la terminal
   * en el buffer equivocado) y después se cierra la PTY — `chainExit`, pero
   * disparado por la señal real y no por una regex.
   *
   * `onPtyExit` pone `running=false` y emite `exited`, y es la vista quien
   * decide qué pinta: desde P-033, el botón Launch.
   */
  private onTuiLeftScreen(): void {
    if (this.exitScheduled) {
      return;
    }
    this.exitScheduled = true;
    this.trace(
      "[pty]",
      `TUI salio de alternate screen (ESC[?1049l) tras ${this.totalBytes} B -> cerrando la sesion`,
    );
    this.setStatus("exited", "la TUI termino; devolviendo el control");
    this.exitTimer = setTimeout(() => {
      this.exitTimer = undefined;
      if (this.chainExit && this.running) {
        this.trace("[pty]", "chainExit: cerrando la PTY tras el fin de la TUI");
        this.client.kill();
      }
    }, 350);
  }

  private onPtyExit(exitCode: number, signal: number | null): void {
    this.trace(
      "[pty]",
      `exit code=${exitCode}${signal !== null ? ` signal=${signal}` : ""} (${this.totalBytes} B recibidos)`,
    );
    this.running = false;
    this.pid = undefined;
    this.setStatus("exited", `el proceso termino con codigo ${exitCode}`);
    this.stateEmitter.fire();

    // P-033: si pulsaron Launch mientras esta PTY se cerraba, toca lanzar ahora
    // — antes `running` seguía true y el intento se habría descartado.
    if (this.pendingLaunch) {
      this.pendingLaunch = false;
      this.trace("[pty]", "lanzamiento aplazado: la PTY anterior termino -> lanzando");
      setTimeout(() => this.launch(), 60);
    }
  }

  /**
   * P-024 — Teclear el comando dentro del shell (P-001: nunca `spawn('opencode')`,
   * el PATH del extension host no es el del usuario).
   *
   * El comando va en su PROPRIA línea. No se encadena `exit`: el TUI de OpenCode
   * usa Cobra, que parsea cualquier token posterior como argumento posicional
   * (`opencode ; exit` → `Unexpected positional argument: "exit"`) y aborta.
   *
   * P-033: `chainExit` ya no se cumple con la heurística de prompt. La TUI
   * restaura alternate screen al salir (`ESC[?1049l`) y es esa señal —medida
   * contra OpenCode real: 0,1 s tras `/exit`, y nunca en 30 s de control— la
   * que cierra la PTY desde `onTuiLeftScreen()`.
   */
  private writeCommand(command: string): void {
    this.trace("[launch]", `escribiendo comando: ${JSON.stringify(command)}`);
    this.client.write(`${command}\r`);
  }

  /** §5.1: el foco lo maneja la vista (el webview recibe el teclado). */
  focus(): void {
    void vscode.commands.executeCommand(`${STATUS_VIEW_ID}.focus`);
  }

  /** §7.4: instancia efímera → matar la PTY y crear una nueva. */
  newSession(): void {
    this.client.kill();
    this.running = false;
    this.pid = undefined;
    this.replay = "";
    this.totalBytes = 0;
    this.stateEmitter.fire();
    this.launch();
  }

  /**
   * §1.1 ③ / T7: único canal hacia el TUI — escribir en el compositor SIN Enter
   * (addNewLine = false) para que el usuario revise y pulse Enter.
   */
  sendToComposer(text: string): boolean {
    if (!this.running) {
      return false;
    }
    this.client.write(text);
    return true;
  }

  /** Datos escritos por el usuario desde xterm.js. */
  write(data: string): void {
    this.client.write(data);
  }

  /** El webview informa de su tamaño real → redimensionar la PTY. */
  resize(cols: number, rows: number): void {
    if (!this.running || cols <= 0 || rows <= 0) {
      return;
    }
    this.client.resize(cols, rows);
  }

  dispose(): void {
    if (this.firstDataTimer) {
      clearTimeout(this.firstDataTimer);
      this.firstDataTimer = undefined;
    }
    if (this.exitTimer) {
      clearTimeout(this.exitTimer);
      this.exitTimer = undefined;
    }
    this.exitScheduled = false;
    this.pendingLaunch = false;
    this.running = false;
    this.pid = undefined;
    for (const d of this.subs) {
      d.dispose();
    }
    this.client.dispose();
    // El emitter NO se dispone aquí: dispose() puede llamarlo la red de seguridad
    // y poder relanzar después (el provider de la vista sigue escuchando).
    this.stateEmitter.fire();
  }
}
