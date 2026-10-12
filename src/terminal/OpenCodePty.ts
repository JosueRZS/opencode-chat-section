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
  /** Escucha de datos usada por `watchPrompt` (se descarta en cada relanzamiento). */
  private promptListener: vscode.Disposable | undefined;
  /** P-027: si tras el spawn no llega ni un byte, decirlo (nunca un "cargando" mudo). */
  private firstDataTimer: ReturnType<typeof setTimeout> | undefined;
  /** Comando a tecleear en el shell en cuanto la PTY confirme el arranque. */
  private pendingCommand = "";

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
   */
  launch(): void {
    if (this.running) {
      this.setStatus("running", "ya hay una instancia en marcha");
      return;
    }

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

    this.trace(
      "[launch]",
      `shell=${shell.file} args=${JSON.stringify(shell.args)} cmd=${JSON.stringify(command)} cwd=${cwd ?? "(default)"} chain=${this.chainExit} conptyDll=${useConptyDll} timeout=${spawnTimeout}ms tui=${JSON.stringify(opencodeTuiEnv())}`,
    );
    this.setStatus("starting", "arrancando el proceso PTY…");

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

    this.watchPrompt();
    this.stateEmitter.fire();
  }

  /** La PTY existe de verdad: ahora sí se teclea el comando (P-001/P-024). */
  private onPtySpawned(pid: number): void {
    this.running = true;
    this.pid = pid;
    this.trace("[pty]", `PTY creada (pid ${pid}); tecleando comando…`);
    this.setStatus("starting", `PTY creada (pid ${pid}), esperando la salida del shell…`);

    // P-027: si en3 s no llega ni un byte, decirlo en la barra de estado.
    this.firstDataTimer = setTimeout(() => {
      if (this.running && this.totalBytes === 0) {
        this.trace("[pty]", `spawn OK (pid ${pid}) pero sin salida tras 3 s`);
        this.setStatus("starting", `spawn correcto (pid ${pid}) pero la PTY aún no manda salida…`);
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
    this.dataEmitter.fire(d);
  }

  private onPtyExit(exitCode: number, signal: number | null): void {
    this.trace(
      "[pty]",
      `exit code=${exitCode}${signal !== null ? ` signal=${signal}` : ""} (${this.totalBytes} B recibidos)`,
    );
    this.running = false;
    this.pid = undefined;
    this.promptListener?.dispose();
    this.promptListener = undefined;
    this.setStatus("exited", `el proceso terminó con código ${exitCode}`);
    this.stateEmitter.fire();
  }

  /**
   * P-024 — Teclear el comando dentro del shell (P-001: nunca `spawn('opencode')`,
   * el PATH del extension host no es el del usuario).
   *
   * El comando va en su PROPRIA línea. No se encadena `exit`: el TUI de OpenCode
   * usa Cobra, que parsea cualquier token posterior como argumento posicional
   * (`opencode ; exit` → `Unexpected positional argument: "exit"`) y aborta.
   * `chainExit` se cumple de otra forma: cuando el TUI termina y vuelve el
   * prompt del shell, la extensión envía `exit` ella misma (ver `watchPrompt`).
   */
  private writeCommand(command: string): void {
    this.trace("[launch]", `escribiendo comando: ${JSON.stringify(command)}`);
    this.client.write(`${command}\r`);
  }

  /**
   * P-024 (§7.3 `chainExit`): cuando el TUI termina y el shell vuelve a
   * imprimir su prompt, la extensión envía `exit` para que la PTY muera
   * con el TUI y la sección vuelva al botón Launch.
   */
  private watchPrompt(): void {
    if (!this.chainExit) {
      return;
    }
    let armado = false;
    const timer = setInterval(() => {
      if (!this.running || armado) {
        clearInterval(timer);
        return;
      }
      if (/[>]\s*$/.test(this.replay)) {
        armado = true;
        clearInterval(timer);
        this.trace("[pty]", "vuelve el prompt del shell ⇒ enviando exit");
        setTimeout(() => {
          if (this.running) {
            this.client.write("exit\r");
          }
        }, 400);
      }
    }, 300);
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
    this.promptListener?.dispose();
    this.promptListener = undefined;
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
