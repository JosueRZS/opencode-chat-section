import * as readline from "readline";

/**
 * P-027 — Proceso **hijo** que aloja `node-pty`.
 *
 * ## Por qué existe
 *
 * Dentro del extension host de VS Code, `pty.spawn()` se bloqueaba **para
 * siempre** (P-026/P-027: el log se cortaba en «node-pty cargado; llamando a
 * spawn()…» y no había ni retorno ni excepción). La causa está en la línea 76
 * de `node-pty/lib/windowsConoutConnection.js`:
 *
 * ```js
 * new Worker(path.join(scriptPath, 'worker/conoutSocketWorker.js'), { workerData })
 * ```
 *
 * El worker se crea **sin `execArgv`**, así que **hereda los flags de
 * `process.execArgv` del extension host** (Electron/VS Code: `--no-sandbox`,
 * `--ms-enable-electron-run-as-node`, la configuración de ventana, etc.). Como
 * todo eso sucede de forma **síncrona** dentro de `spawn()`, el bloqueo no solo
 * impedía arrancar el TUI: **congelaba el extension host entero**, y por eso ni
 * llegaban los clics ni aparecía ningún error.
 *
 * Fuera de VS Code (`node pty-test.js`) `process.execArgv` está vacío ⇒ 289-616 ms.
 *
 * ## La solución
 *
 * Alojar node-pty en este proceso hijo — la misma arquitectura que VS Code usa
 * para su propio `ptyhost`. Aquí `process.execArgv` está limpio, y además el
 * fallo queda **manejable**: si el hijo no contesta, la extensión lo detecta con
 * timeout y lo mata, en vez de congelarse.
 *
 * ## Protocolo
 *
 * Líneas JSON por stdin (entrada) y stdout (salida). Los bytes de la PTY viajan
 * **en base64** para que ninguna secuencia ANSI ni byte UTF-8 multi‑byte se
 * corrompa al cruzar el canal.
 *
 * ⚠️ stdout es el canal de datos: este proceso **nunca** debe usar `console.*`.
 */
import type { IPty } from "node-pty";

type InMsg =
  | {
      type: "launch";
      id: number;
      file: string;
      args: string[];
      cwd?: string;
      env: Record<string, string>;
      cols: number;
      rows: number;
      useConpty: boolean;
      useConptyDll: boolean;
    }
  | { type: "input"; id: number; data: string }
  | { type: "resize"; id: number; cols: number; rows: number }
  | { type: "kill"; id: number }
  | { type: "ping" };

const ptys = new Map<number, IPty>();

function send(msg: unknown): void {
  try {
    process.stdout.write(`${JSON.stringify(msg)}\n`);
  } catch {
    /* el padre ya cerró el canal */
  }
}

function describe(e: unknown): string {
  return e instanceof Error ? `${e.name}: ${e.message}` : String(e);
}

// Aviso de arranque: el padre usa `execArgv` para confirmar que este proceso es
// un Node limpio (sin los flags del extension host).
send({
  type: "booted",
  pid: process.pid,
  execPath: process.execPath,
  execArgv: process.execArgv,
});

function handle(msg: InMsg): void {
  switch (msg.type) {
    case "ping":
      send({ type: "pong" });
      return;

    case "launch": {
      // `node-pty` es externo en esbuild: se resuelve subiendo desde dist/.
      const ptyModule = require("node-pty") as typeof import("node-pty");
      const p = ptyModule.spawn(msg.file, msg.args, {
        name: "xterm-256color",
        cols: msg.cols,
        rows: msg.rows,
        // node-pty hace `path.resolve(cwd)`: undefined explotaría (no hay
        // carpeta abierta ⇒ `resolveCwd` puede devolver undefined).
        cwd: msg.cwd && msg.cwd.trim() ? msg.cwd : process.cwd(),
        env: msg.env,
        useConpty: msg.useConpty,
        useConptyDll: msg.useConptyDll,
      });
      ptys.set(msg.id, p);
      send({ type: "spawned", id: msg.id, pid: p.pid });
      p.onData(d => {
        send({ type: "data", id: msg.id, data: Buffer.from(d, "utf8").toString("base64") });
      });
      p.onExit(e => {
        ptys.delete(msg.id);
        send({ type: "exit", id: msg.id, exitCode: e.exitCode, signal: e.signal ?? null });
      });
      return;
    }

    case "input": {
      const p = ptys.get(msg.id);
      if (p) {
        p.write(Buffer.from(msg.data, "base64").toString("utf8"));
      }
      return;
    }

    case "resize": {
      const p = ptys.get(msg.id);
      if (p) {
        try {
          p.resize(msg.cols, msg.rows);
        } catch {
          /* ConPTY puede rechazar un resize transitorio */
        }
      }
      return;
    }

    case "kill": {
      const p = ptys.get(msg.id);
      ptys.delete(msg.id);
      try {
        p?.kill();
      } catch {
        /* ya muerta */
      }
      return;
    }
  }
}

const rl = readline.createInterface({ input: process.stdin });

rl.on("line", line => {
  if (!line.trim()) {
    return;
  }
  let msg: InMsg;
  try {
    msg = JSON.parse(line) as InMsg;
  } catch {
    return;
  }
  try {
    handle(msg);
  } catch (e) {
    send({ type: "error", id: "id" in msg ? (msg as { id: number }).id : 0, message: describe(e) });
  }
});

// El padre ha muerto (o cerró el tubo): no quedarnos huérfanos con el TUI vivo.
rl.on("close", () => {
  for (const [, p] of ptys) {
    try {
      p.kill();
    } catch {
      /* ya muerta */
    }
  }
  process.exit(0);
});
