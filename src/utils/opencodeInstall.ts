import * as vscode from "vscode";
import { spawn, execFile } from "child_process";
import { envWithPath } from "./shell";
import { stamp } from "./log";
import type { FileLog } from "./filelog";

/**
 * Fase 3 — guardia de instalación (P-031).
 *
 * Flujo paso a paso que pidió el usuario:
 *   1. **comprobar** si `opencode` está disponible;
 *   2. si no lo está, **preguntar** con un modal `[Sí, instalar]` / `[No]`;
 *   3. **instalar** con progreso visible (notificación de VS Code + Salida);
 *   4. **re-comprobar** y, en cualquier caso, **arrancar** la sección.
 *
 * ## Por qué la comprobación se hace con `envWithPath()`
 *
 * P-001: el PATH del extension host no es el del usuario. `where.exe`/`command -v`
 * se ejecutan con el MISMO entorno que después recibirá la PTY, así que el
 * resultado es el que verá la terminal — no un falso negativo por npm global ausente.
 *
 * ## Por qué se comprueba también `~/.opencode/bin`
 *
 * El instalador oficial (`curl -fsSL https://opencode.ai/install | bash`) instala
 * ahí y **solo** lo añade al PATH escribiéndolo en `.bashrc`/`.zshrc`: afecta a
 * futuros shells, no al entorno heredado. `envWithPath()` ya incluye ese
 * directorio si existe, por eso basta con la comprobación por PATH.
 *
 * ## Por qué NUNCA se bloquea el arranque
 *
 * La sección ES la terminal (P-028): aunque el usuario diga "No" o la
 * instalación falle, se lanza igualmente y el propio shell muestra su error.
 * Esta guardía es una ayuda, no una puerta.
 */

/** Paquete npm ACTUAL de OpenCode v2. `opencode-ai` está congelado en 1.19.0. */
export const NPM_PACKAGE = "@opencode/cli";

/** Instalador oficial (bash). Verificado en https://opencode.ai/install. */
const SCRIPT_URL = "https://opencode.ai/install";

export interface ProbeResult {
  found: boolean;
  /** Ruta encontrada, o el motivo de no encontrarlo. Va al Output. */
  detail: string;
}

/** Devuelve la ruta de `opencode` si es invocable con el entorno de la PTY. */
export function probeOpencode(): Promise<ProbeResult> {
  const cmd = process.platform === "win32" ? "where.exe" : "/bin/sh";
  const args = process.platform === "win32" ? ["opencode"] : ["-lc", "command -v opencode"];
  return new Promise(resolve => {
    execFile(
      cmd,
      args,
      { env: envWithPath(), timeout: 6000, windowsHide: true },
      (err, stdout, stderr) => {
        const out = (stdout ?? "").trim();
        if (!err && out) {
          // `where` puede devolver varias rutas: nos quedamos con la primera.
          resolve({ found: true, detail: out.split(/\r?\n/)[0] });
          return;
        }
        resolve({
          found: false,
          detail: (stderr || err?.message || "sin salida").trim().slice(0, 200),
        });
      },
    );
  });
}

export interface InstallOutcome {
  ok: boolean;
  detail: string;
}

/**
 * Ejecuta la instalación. `method`:
 *  - `npm`    → `npm install -g @opencode/cli`
 *  - `script` → `curl -fsSL https://opencode.ai/install | bash` (POSIX; en
 *               Windows se recurre a npm, que es el camino documentado allí)
 *  - `auto`   → npm (funciona en todas las plataformas y ya está presente)
 */
export function installOpencode(
  method: string,
  onLine: (line: string) => void,
): Promise<InstallOutcome> {
  const useScript = method === "script" && process.platform !== "win32";
  const command = useScript
    ? `curl -fsSL ${SCRIPT_URL} | bash`
    : `npm install -g ${NPM_PACKAGE}`;

  return new Promise<InstallOutcome>(resolve => {
    let settled = false;
    const finish = (ok: boolean, detail: string): void => {
      if (!settled) {
        settled = true;
        resolve({ ok, detail });
      }
    };

    // `spawn` + shell: hay que ir leyendo la salida en directo (npm es ruidoso),
    // y `exec` la Bufferiza hasta el final.
    let child;
    try {
      child = spawn(command, { env: envWithPath(), shell: true, windowsHide: true });
    } catch (e) {
      finish(false, e instanceof Error ? e.message : String(e));
      return;
    }

    const pump = (chunk: Buffer | string): void => {
      for (const line of String(chunk).split(/\r?\n/)) {
        const t = line.trim();
        if (t) {
          onLine(t);
        }
      }
    };
    child.stdout?.on("data", pump);
    child.stderr?.on("data", pump);
    child.on("error", e => finish(false, e.message));
    // Si el usuario cancela la ventana o VS Code se va, no dejar huérfanos.
    child.on("close", code => finish(code === 0, `código de salida ${code}`));
  });
}

/**
 * Punto de entrada de la Fase 3. Nunca lanza excepción: el llamante debe poder
 * continuar con el arranque pase lo que pase.
 */
export async function ensureOpencodeAvailable(
  output: vscode.OutputChannel,
  fileLog: FileLog | undefined,
  onPhase: (phase: string, detail: string) => void,
): Promise<void> {
  const cfg = vscode.workspace.getConfiguration("opencodeChat");
  const autoPrompt = cfg.get<boolean>("autoPromptInstall", true);
  const method = cfg.get<string>("installMethod", "auto");

  onPhase("checking", "comprobando si OpenCode está disponible…");
  const probe = await probeOpencode();
  const probeLine = `[install] probe found=${probe.found} :: ${probe.detail}`;
  output.appendLine(`${stamp()} ${probeLine}`);
  fileLog?.write(probeLine);

  if (probe.found) {
    onPhase("idle", "");
    return;
  }

  if (!autoPrompt) {
    output.appendLine(`${stamp()} [install] no encontrado y autoPromptInstall=false → se lanza igualmente`);
    onPhase("idle", "");
    return;
  }

  // Paso 2 — pregunta. Esc o cierre = "No".
  const pick = await vscode.window.showWarningMessage(
    "OpenCode no se ha encontrado en tu PATH. ¿Instalarlo ahora?",
    { modal: true },
    "Sí, instalar",
    "No",
  );
  fileLog?.write(`[install] respuesta del usuario: ${pick ?? "(descartado)"}`);
  if (pick !== "Sí, instalar") {
    onPhase("idle", "");
    return;
  }

  // Paso 3 — instalación con progreso.
  output.appendLine(`${stamp()} [install] método=${method} (npm => ${NPM_PACKAGE})`);
  const result = await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: "Instalando OpenCode…",
      cancellable: false,
    },
    async progress =>
      installOpencode(method, line => {
        progress.report({ message: line.slice(-140) });
        output.appendLine(`${stamp()} [install] ${line}`);
        fileLog?.write(`[install] ${line}`);
      }),
  );

  const outcomeLine = `[install] fin: ok=${result.ok} ${result.detail}`;
  output.appendLine(`${stamp()} ${outcomeLine}`);
  fileLog?.write(outcomeLine);

  // Paso 4 — re-comprobar.
  const after = await probeOpencode();
  output.appendLine(`${stamp()} [install] re-comprobación found=${after.found} :: ${after.detail}`);
  fileLog?.write(`[install] re-comprobación found=${after.found}`);

  if (!after.found || !result.ok) {
    void vscode.window
      .showErrorMessage(
        `No se pudo instalar OpenCode (${result.detail}). Revisa View → Output → "OpenCode Chat".`,
        "Ver salida",
      )
      .then(choice => {
        if (choice === "Ver salida") {
          output.show(true);
        }
      });
  }

  // La sección ES la terminal: se lanza pase lo que pase (P-028).
  onPhase("idle", "");
}
