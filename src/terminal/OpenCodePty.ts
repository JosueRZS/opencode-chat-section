import * as vscode from "vscode";
import type { IPty } from "node-pty";
import { buildOpencodeCommand, envWithPath, resolveCwd, resolveShell } from "../utils/shell";
import { STATUS_VIEW_ID } from "../utils/placement";
import { stamp } from "../utils/log";

/**
 * La instancia efímera de OpenCode (D1) sobre una **PTY real** (`node-pty`).
 *
 * Por qué PTY y no `vscode.window.createTerminal` (P-022): un terminal de VS Code
 * solo puede vivir en el Panel o en un Editor (P-017) — **nunca dentro de una vista**.
 * Para que el TUI se renderice DENTRO de la sección OpenCode (debajo de Chat) hay que
 * alojarlo en un WebviewView con xterm.js, y eso exige una PTY propia.
 *
 * `node-pty@1.1.0` usa **N-API** (`napi_register_module_v1`) → ABI estable, carga en el
 * extension host de Electron sin recompilar contra cada versión de VS Code.
 *
 * El shell se arranca igual que antes (P-001): nunca `spawn('opencode')` a pelo, porque el
 * PATH del extension host no es el del usuario; se teclea el comando dentro del shell, que
 * sí resuelve `opencode` igual que en una terminal normal.
 */
export class OpenCodePty implements vscode.Disposable {
  private proc: IPty | undefined;
  private readonly stateEmitter = new vscode.EventEmitter<void>();
  private readonly dataEmitter = new vscode.EventEmitter<string>();

  /** Se dispara al crear/matar la PTY (para la vista). */
  readonly onDidChangeState = this.stateEmitter.event;
  /** Salida cruda de la PTY, para reenviarla a xterm.js. */
  readonly onDidReceiveData = this.dataEmitter.event;

  /**
   * Reemplazo del stdout perdido: con `retainContextWhenHidden` el webview persiste,
   * pero al ABRIR la vista por primera vez con la TUI ya corriendo hay que repintar.
   * Guardamos un tope para no crecer sin límite.
   */
  private replay = "";
  private static readonly MAX_REPLAY = 512 * 1024;

  /** P-024: si el TUI muere, la PTY debe morir con él (§7.3 `chainExit`). */
  private chainExit = true;
  /** Escucha de datos usada por `watchPrompt` (se descarta en cada relanzamiento). */
  private promptListener: vscode.Disposable | undefined;

  constructor(private readonly output: vscode.OutputChannel) {}

  get isRunning(): boolean {
    return this.proc !== undefined;
  }

  /** Salida acumulada desde el arranque (para repintar el webview al abrirlo). */
  get replayBuffer(): string {
    return this.replay;
  }

  /**
   * §1.1 + §4: lanza OpenCode dentro de una PTY. Si ya corre, no hace nada
   * (una sola instancia, §7.4) — el foco lo resuelve `focus()`.
   */
  launch(): void {
    if (this.proc) {
      return;
    }

    const cfg = vscode.workspace.getConfiguration("opencodeChat");
    const chainExit = cfg.get<boolean>("chainExit", true);
    const shell = resolveShell();
    const cwd = resolveCwd(cfg.get<string>("terminalCwd"));
    const command = buildOpencodeCommand(chainExit);

    let proc: IPty;
    try {
      const pty = require("node-pty") as typeof import("node-pty");
      proc = pty.spawn(shell.file, shell.args, {
        name: "xterm-256color",
        cols: 80,
        rows: 24,
        cwd,
        env: envWithPath(),
        // ConPTY (Win10 1809+): es lo que VS Code usa por defecto y lo que el TUI necesita.
        useConpty: process.platform === "win32",
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      this.output.appendLine(`${stamp()} [pty] no se pudo crear la PTY: ${msg}`);
      void vscode.window.showErrorMessage(
        `OpenCode Chat: no se pudo crear la terminal (${msg}). ¿Se instaló node-pty para tu plataforma?`,
      );
      return;
    }

    this.proc = proc;
    this.replay = "";
    this.chainExit = chainExit;
    // P-024: se envía el comando en su PROPIA línea. El TUI (Cobra) parsea
    // cualquier token extra como argumento posicional, así que nunca encadenamos
    // `exit` detrás. `chainExit` se aplica observing el prompt del shell.
    this.writeCommand(command);

    proc.onData(d => {
      this.replay += d;
      if (this.replay.length > OpenCodePty.MAX_REPLAY) {
        this.replay = this.replay.slice(-OpenCodePty.MAX_REPLAY);
      }
      this.dataEmitter.fire(d);
    });

    proc.onExit(e => {
      this.output.appendLine(`${stamp()} [pty] exit code=${e.exitCode}${e.signal ? ` signal=${e.signal}` : ""}`);
      this.proc = undefined;
      this.promptListener?.dispose();
      this.promptListener = undefined;
      this.stateEmitter.fire();
    });

    this.watchPrompt();

    this.output.appendLine(
      `${stamp()} [launch] loc=webview-pty shell=${shell.file} chain=${chainExit} cwd=${cwd ?? "(default)"} pid=${proc.pid}`,
    );

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
    void this.proc?.write(`${command}\r`);
  }

  /**
   * P-024 (§7.3 `chainExit`): cuando el TUI termina y el shell vuelve a
   * imprimir su prompt, la extensión envía `exit` para que la PTY muera
   * con el TUI y la sección vuelva al botón Launch.
   *
   * Antes esto se resolvía encadenando `opencode ; exit`, que **rompía el
   * arranque**: Cobra parsea `exit` como argumento posicional.
   */
  private watchPrompt(): void {
    this.promptListener?.dispose();
    this.promptListener = undefined;
    if (!this.chainExit) {
      return;
    }
    const p = this.proc;
    if (!p) {
      return;
    }
    let armado = false;
    // El prompt del shell (cmd `X>` / PowerShell `PS X>`) solo vuelve a
    // imprimirse cuando `opencode` ha terminado.
    const timer = setInterval(() => {
      if (!this.proc || this.proc !== p) {
        clearInterval(timer);
        return;
      }
      if (!armado && /[>]\s*$/.test(this.replay)) {
        armado = true;
        clearInterval(timer);
        setTimeout(() => {
          if (this.proc === p) {
            void p.write("exit\r");
          }
        }, 400);
      }
    }, 300);
  }

  /** §5.1: el foco lo maneja la vista (el webview recibe el teclado). */
  focus(): void {
    // Sin-op intencional: `TuiViewProvider` enfoca el terminal al volverse visible.
    // Aquí solo garantizamos que la vista exista.
    void vscode.commands.executeCommand(`${STATUS_VIEW_ID}.focus`);
  }

  /** §7.4: instancia efímera → matar la PTY y crear una nueva. */
  newSession(): void {
    const old = this.proc;
    this.proc = undefined;
    this.promptListener?.dispose();
    this.promptListener = undefined;
    if (old) {
      try {
        old.kill();
      } catch {
        /* la PTY ya podía haber muerto */
      }
    }
    this.replay = "";
    this.stateEmitter.fire();
    this.launch();
  }

  /**
   * §1.1 ③ / T7: único canal hacia el TUI — escribir en el compositor SIN Enter
   * (addNewLine = false) para que el usuario revise y pulse Enter.
   */
  sendToComposer(text: string): boolean {
    if (!this.proc) {
      return false;
    }
    this.proc.write(text);
    return true;
  }

  /** Datos escritos por el usuario desde xterm.js. */
  write(data: string): void {
    this.proc?.write(data);
  }

  /** El webview informa de su tamaño real → redimensionar la PTY. */
  resize(cols: number, rows: number): void {
    if (!this.proc || cols <= 0 || rows <= 0) {
      return;
    }
    try {
      this.proc.resize(cols, rows);
    } catch {
      /* ConPTY puede rechazar un resize transitorio */
    }
  }

  dispose(): void {
    const old = this.proc;
    this.proc = undefined;
    this.promptListener?.dispose();
    this.promptListener = undefined;
    if (old) {
      try {
        old.kill();
      } catch {
        /* ya muerta */
      }
    }
    // El emitter NO se dispone aquí: dispose() puede llamarlo la red de seguridad
    // y poder relanzar después (el provider de la vista sigue escuchando).
    this.stateEmitter.fire();
  }
}
