import * as fs from "fs";
import * as path from "path";
import * as os from "os";

/**
 * P-025 — Log a fichero con escritura **síncrona**.
 *
 * Por qué existe: el canal de salida de VS Code (`OutputChannel`) se escribe de
 * forma **asíncrona** y vive en el extension host. Si el host se cuelga o muere
 * justo después de `pty.spawn()` (P-024, causa 3), las últimas líneas se
 * pierden — y con ellas la única pista de dónde se bloqueó. `appendFileSync`
 * escribe ya en disco, así que el log sobrevive a cualquier cuelgue posterior.
 *
 * Además se accumulates en memoria (`lines`) para poder volcarlo al webview
 * (panel de diagnóstico) o al portapapeles sin volver a leer el fichero.
 */
export class FileLog {
  /** Máximo de líneas retenidas en memoria (el fichero guarda todo). */
  private static readonly MAX_MEMORY = 200;

  private readonly file: string;
  private readonly lines: string[] = [];
  private failed = false;

  constructor(fileName: string) {
    this.file = path.join(
      process.env.TEMP ?? os.tmpdir(),
      "opencode-chat",
      fileName,
    );
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
    } catch {
      this.failed = true;
    }
  }

  /** Ruta absoluta del fichero (se la mostramos al usuario para que lo abra). */
  get path(): string {
    return this.file;
  }

  /** Escribe una línea ya formateada. Nunca lanza. */
  write(line: string): void {
    const stamped = `${new Date().toISOString().slice(11, 23)} [pid ${process.pid}] ${line}`;
    this.lines.push(stamped);
    if (this.lines.length > FileLog.MAX_MEMORY) {
      this.lines.shift();
    }
    if (this.failed) {
      return;
    }
    try {
      // appendFileSync: si el host se cuelga después, la línea YA está en disco.
      fs.appendFileSync(this.file, `${stamped}\n`, "utf8");
    } catch {
      this.failed = true;
    }
  }

  /** Volcado de las últimas líneas (para el webview / portapapeles). */
  tail(count = 40): string {
    return this.lines.slice(-count).join("\n");
  }
}