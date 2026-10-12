import { type ChildProcessWithoutNullStreams, spawn } from "child_process";
import * as vscode from "vscode";

/** Especificación de arranque de una PTY, en nombre del proceso hijo. */
export interface PtyLaunchSpec {
  file: string;
  args: string[];
  cwd?: string;
  env: Record<string, string | undefined>;
  cols: number;
  rows: number;
  useConpty: boolean;
  useConptyDll: boolean;
}

/** Resultado del arranque del propio proceso hijo (P-027). */
export interface PtyHostBoot {
  pid: number;
  execPath: string;
  execArgv: string[];
}

/**
 * P-027 — Cliente del proceso hijo que aloja `node-pty`.
 *
 * Motivo (P-026/P-027): `pty.spawn()` llamado **dentro** del extension host se
 * bloqueaba para siempre y congelaba la ventana entera. Este cliente mantiene
 * node-pty fuera del host, en un proceso Node limpio, y lo más importante:
 * **pone plazo** a cada paso. Si el hijo no contesta, la extensión sigue viva,
 * informa del fallo y mata al hijo — ya no puede haber congelación silenciosa.
 *
 * Protocolo: líneas JSON por stdin/stdout; los bytes de la PTY van en base64.
 */
export class PtyHostClient implements vscode.Disposable {
  private child: ChildProcessWithoutNullStreams | undefined;
  private buffer = "";
  private nextId = 0;
  /** Id de la PTY viva (una sola, §7.4: instancia efímera). */
  private currentId = 0;
  private bootTimer: ReturnType<typeof setTimeout> | undefined;
  private spawnTimer: ReturnType<typeof setTimeout> | undefined;

  private readonly bootEmitter = new vscode.EventEmitter<PtyHostBoot>();
  private readonly spawnEmitter = new vscode.EventEmitter<{ id: number; pid: number }>();
  private readonly dataEmitter = new vscode.EventEmitter<string>();
  private readonly exitEmitter = new vscode.EventEmitter<{ exitCode: number; signal: number | null }>();
  private readonly errorEmitter = new vscode.EventEmitter<string>();

  /** El proceso hijo arrancó (aquí sabemos si es un Node limpio o no). */
  readonly onDidBoot = this.bootEmitter.event;
  /** La PTY se creó de verdad; trae el pid real del shell. */
  readonly onDidSpawn = this.spawnEmitter.event;
  readonly onDidReceiveData = this.dataEmitter.event;
  readonly onDidExit = this.exitEmitter.event;
  readonly onError = this.errorEmitter.event;

  constructor(
    private readonly hostScript: string,
    private readonly cwd: string,
    private readonly execPath: string = process.execPath,
  ) {}

  get isRunning(): boolean {
    return this.currentId !== 0;
  }

  /** Arranca el proceso hijo si aún no existe (con plazo de arranque). */
  start(spawnTimeoutMs = 5000): void {
    if (this.child) {
      return;
    }
    try {
      this.child = spawn(this.execPath, [this.hostScript], {
        cwd: this.cwd,
        windowsHide: true,
        stdio: ["pipe", "pipe", "pipe"],
        // `ELECTRON_RUN_AS_NODE`: en el extension host `execPath` es el binario
        // de Electron; con esta bandera corre como Node normal (sin su execArgv).
        env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
      });
    } catch (e) {
      this.errorEmitter.fire(`no se pudo arrancar el proceso PTY: ${this.describe(e)}`);
      return;
    }

    const child = this.child;

    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => this.consume(chunk));
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      // stderr solo informativo: lo mandamos como error para verlo en Salida.
      if (chunk.trim()) {
        this.errorEmitter.fire(`proceso PTY (stderr): ${chunk.trim()}`);
      }
    });
    child.on("exit", code => {
      this.clearTimers();
      this.child = undefined;
      const wasRunning = this.currentId !== 0;
      this.currentId = 0;
      if (wasRunning) {
        this.exitEmitter.fire({ exitCode: code ?? -1, signal: null });
      }
    });
    child.on("error", e => {
      this.errorEmitter.fire(`proceso PTY: ${this.describe(e)}`);
    });

    // Plazo de arranque: si el hijo no habla, avisamos y lo matamos.
    this.bootTimer = setTimeout(() => {
      this.errorEmitter.fire(
        `el proceso PTY no respondió en ${spawnTimeoutMs} ms (¿no existe el host en ${this.hostScript}?)`,
      );
      this.kill();
    }, spawnTimeoutMs);
  }

  /** Envía el comando de arranque al hijo; espera `spawned` con plazo. */
  launch(spec: PtyLaunchSpec, spawnTimeoutMs = 10000): number {
    this.start();
    this.nextId += 1;
    const id = this.nextId;
    this.currentId = id;
    this.send({ type: "launch", id, ...spec });
    this.spawnTimer = setTimeout(() => {
      this.errorEmitter.fire(
        `node-pty no confirmó el arranque en ${spawnTimeoutMs} ms (pid ${id})`,
      );
      this.kill();
    }, spawnTimeoutMs);
    return id;
  }

  write(data: string): void {
    if (this.currentId && this.child) {
      this.send({ type: "input", id: this.currentId, data: Buffer.from(data, "utf8").toString("base64") });
    }
  }

  resize(cols: number, rows: number): void {
    if (this.currentId && this.child) {
      this.send({ type: "resize", id: this.currentId, cols, rows });
    }
  }

  /** Mata la PTY viva y, con ella, el TUI. */
  kill(): void {
    if (this.currentId && this.child) {
      this.send({ type: "kill", id: this.currentId });
    }
    this.currentId = 0;
  }

  /** Mata también el proceso hijo (dispose / reinicio). */
  killHost(): void {
    this.clearTimers();
    const child = this.child;
    this.child = undefined;
    this.currentId = 0;
    if (child) {
      try {
        child.kill();
      } catch {
        /* ya muerto */
      }
    }
  }

  dispose(): void {
    this.killHost();
    this.bootEmitter.dispose();
    this.spawnEmitter.dispose();
    this.dataEmitter.dispose();
    this.exitEmitter.dispose();
    this.errorEmitter.dispose();
  }

  // --- Internos ---

  private send(msg: unknown): void {
    try {
      this.child?.stdin.write(`${JSON.stringify(msg)}\n`);
    } catch (e) {
      this.errorEmitter.fire(`no se pudo escribir al proceso PTY: ${this.describe(e)}`);
    }
  }

  /** Reconstruye las líneas JSON que llegan del hijo (puede partirse en trozos). */
  private consume(chunk: string): void {
    this.buffer += chunk;
    let idx: number;
    while ((idx = this.buffer.indexOf("\n")) >= 0) {
      const line = this.buffer.slice(0, idx).trim();
      this.buffer = this.buffer.slice(idx + 1);
      if (line) {
        this.handleLine(line);
      }
    }
  }

  private handleLine(line: string): void {
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(line) as Record<string, unknown>;
    } catch {
      return;
    }
    switch (msg.type) {
      case "booted": {
        this.clearBootTimer();
        this.bootEmitter.fire({
          pid: Number(msg.pid),
          execPath: String(msg.execPath),
          execArgv: Array.isArray(msg.execArgv) ? (msg.execArgv as string[]) : [],
        });
        return;
      }
      case "spawned": {
        this.clearSpawnTimer();
        this.spawnEmitter.fire({ id: Number(msg.id), pid: Number(msg.pid) });
        return;
      }
      case "data": {
        if (typeof msg.data === "string") {
          this.dataEmitter.fire(Buffer.from(msg.data, "base64").toString("utf8"));
        }
        return;
      }
      case "exit": {
        this.clearSpawnTimer();
        this.currentId = 0;
        this.exitEmitter.fire({
          exitCode: Number(msg.exitCode),
          signal: msg.signal === null || msg.signal === undefined ? null : Number(msg.signal),
        });
        return;
      }
      case "error": {
        this.errorEmitter.fire(String(msg.message ?? "error desconocido en el proceso PTY"));
        return;
      }
      case "pong":
        return;
    }
  }

  private clearBootTimer(): void {
    if (this.bootTimer) {
      clearTimeout(this.bootTimer);
      this.bootTimer = undefined;
    }
  }

  private clearSpawnTimer(): void {
    if (this.spawnTimer) {
      clearTimeout(this.spawnTimer);
      this.spawnTimer = undefined;
    }
  }

  private clearTimers(): void {
    this.clearBootTimer();
    this.clearSpawnTimer();
  }

  private describe(e: unknown): string {
    return e instanceof Error ? `${e.name}: ${e.message}` : String(e);
  }
}
