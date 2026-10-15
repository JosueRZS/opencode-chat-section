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

/** Paquete ACTUAL de OpenCode v2. `opencode-ai` está congelado en la v1. */
export const NPM_PACKAGE = "@opencode/cli";

/** Instalador oficial (bash) de v2. Verificado en https://opencode.ai/download. */
const SCRIPT_URL = "https://opencode.ai/v2/install";

/**
 * Instaladores oficiales de v2, en el ORDEN en que los publica
 * https://opencode.ai/download. Se respeta ese orden porque es la
 * recomendación del propio proyecto, no un capricho nuestro.
 *
 * `bun` y `pnpm` llevan sus flags de confianza (`--trust`, `--allow-build`)
 * porque el paquete instala un binario NATIVO desde un script postinstall: sin
 * esos flags el gestor lo bloquea y la instalación termina sin binario, sin
 * error claro. `bun install -g` sin `--trust` es el fallo más fácil de tener.
 *
 * `command` es la línea entera tal cual se ejecuta; `manager` es el binario que
 * hay que tener en el PATH para que esa línea tenga sentido.
 */
export interface InstallerSpec {
  id: string;
  manager: string;
  command: string;
  /** Plataformas donde la línea tiene sentido; omitido = todas. */
  platforms?: NodeJS.Platform[];
}

/**
 * Catálogo de instaladores oficiales. Se exporta en vez de dejarlo privado
 * porque el TEXTO de cada comando es la decisión importante de este archivo:
 * `opencode-ai` (v1) en lugar de `@opencode/cli` (v2), o un `bun install -g`
 * sin `--trust`, instalan algo que después no arranca y lo hacen sin un error
 * evidente. Los tests son los que impiden ese retroceso.
 */
export const INSTALLER_CATALOG: readonly InstallerSpec[] = [
  { id: "npm", manager: "npm", command: `npm install -g ${NPM_PACKAGE}` },
  { id: "bun", manager: "bun", command: `bun install -g --trust ${NPM_PACKAGE}` },
  { id: "pnpm", manager: "pnpm", command: `pnpm add -g --allow-build=${NPM_PACKAGE} ${NPM_PACKAGE}` },
  { id: "yarn", manager: "yarn", command: `yarn global add ${NPM_PACKAGE}` },
  {
    id: "script",
    manager: "curl",
    command: `curl -fsSL ${SCRIPT_URL} | bash`,
    // El script POSIX no existe en Windows: allí el propio proyecto manda a npm.
    platforms: ["darwin", "linux"],
  },
  { id: "brew", manager: "brew", command: "brew install anomalyco/tap/opencode-v2", platforms: ["darwin"] },
];

export interface DetectedInstaller {
  id: string;
  command: string;
}

/** ¿Está el gestor en el mismo PATH que después recibirá la PTY? */
function managerExists(manager: string): Promise<boolean> {
  const file = process.platform === "win32" ? "where.exe" : "/bin/sh";
  const args = process.platform === "win32" ? [manager] : ["-lc", `command -v ${manager}`];
  return new Promise(resolve => {
    execFile(file, args, { env: envWithPath(), timeout: 6000, windowsHide: true }, err => resolve(!err));
  });
}

/**
 * Devuelve los instaladores oficiales cuyo gestor está realmente instalado, en
 * el orden oficial. Se comprueban EN SERIE y no en paralelo: son sondas de
 * milisegundos y en serie el resultado llega ya ordenado sin tener que
 * reordenarlo después.
 */
export async function detectInstallers(): Promise<DetectedInstaller[]> {
  const out: DetectedInstaller[] = [];
  for (const spec of INSTALLER_CATALOG) {
    if (spec.platforms && !spec.platforms.includes(process.platform)) {
      continue;
    }
    if (await managerExists(spec.manager)) {
      out.push({ id: spec.id, command: spec.command });
    }
  }
  return out;
}

/**
 * Elige entre los instaladores ya detectados.
 *
 * Pura y separada de `detectInstallers` a propósito: la detección necesita
 * procesos (hay que preguntar al PATH si existe cada gestor) y el criterio de
 * elección no. Así se prueba sin llegar a spawneear npm ni bun.
 *
 * `auto` —y cualquier valor desconocido— sigue el orden oficial y se queda con
 * el primero disponible. Si se pide un gestor concreto y no está, se cae al
 * primero que sí: pedir `bun` y no tenerlo no debe dejar al usuario sin
 * instalación.
 *
 * Nota: `method` sale de la configuración del usuario y aquí únicamente se
 * COMPARA contra `id`; nunca entra en el texto del comando. `installOpencode`
 * sólo recibe líneas del catálogo cerrado, así que no hay vía de inyección.
 */
export function pickInstaller(
  method: string,
  available: readonly DetectedInstaller[],
): DetectedInstaller | undefined {
  if (available.length === 0) {
    return undefined;
  }
  if (method === "auto") {
    return available[0];
  }
  return available.find(i => i.id === method) ?? available[0];
}

export async function resolveInstaller(method: string): Promise<DetectedInstaller | undefined> {
  return pickInstaller(method, await detectInstallers());
}

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
 * Ejecuta la instalación con la línea que haya resuelto `resolveInstaller`.
 *
 * Se pasa la línea ENTERA y no un "método" para que no haya dos sitios donde
 * decidir qué se ejecuta: el comando que se muestra al usuario en el panel es
 * literalmente el que corre. Si esa visibilidad no existiera, un `--trust`
 * olvidado en bun pasaría desapercibido hasta que el binario no apareciera.
 */
export function installOpencode(
  command: string,
  onLine: (line: string) => void,
): Promise<InstallOutcome> {
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
    child.on("close", code =>
      finish(code === 0, code === 0 ? "" : vscode.l10n.t("exit code {0}", code ?? "?")),
    );
  });
}

/**
 * Qué decidió la guardia, para que la sección sepa si puede autoarrancar.
 *
 *  - `available`: el CLI estaba; no ha ocurrido nada y se arranca como siempre.
 *  - `blocked`: la guardia tuvo que intervenir (faltaba OpenCode y hubo que
 *    preguntar/instalar). En ese caso la sección NO se autoarranca: vuelve al
 *    botón Launch y el usuario decide cuándo arrancar — que es exactamente lo
 *    que pasa tras cada salida visible (P-033).
 */
export interface GuardResult {
  outcome: "available" | "blocked";
  /** Motivo a mostrar si la instalación falló; vacío en caso contrario. */
  error: string;
}

/** Qué se le presenta al usuario dentro de la sección (P-044). */
export interface InstallOffer {
  message: string;
  /** Línea EXACTA que se va a ejecutar, mostrada sin recortar. */
  command: string;
}

/**
 * Guardia de instalación (P-031 → P-044).
 *
 * La pregunta ya **no es un diálogo modal de VS Code**: es un panel dentro de la
 * propia sección, en la misma pantalla donde vive el botón Launch. Un modal
 * aparte rompía la idea de P-028 —la sección ES la terminal— porque metía una
 * ventana del editor en medio de algo que debería ocurrir en su sitio.
 *
 * `ask` presenta esa pregunta y devuelve la respuesta. Si no hay sección que
 * pueda contestar (aún no resuelta, o vista recreándose) no se pregunta y se
 * devuelve `blocked`; la sección acaba en el botón Launch. P-028 sigue intacto:
 * nada queda bloqueado, sólo se espera a que el usuario pulse.
 *
 * Nunca lanza excepción: el llamante debe poder continuar pase lo que pase.
 */
export async function ensureOpencodeAvailable(
  output: vscode.OutputChannel,
  fileLog: FileLog | undefined,
  onPhase: (phase: string, detail: string) => void,
  ask: ((offer: InstallOffer) => Promise<boolean>) | undefined,
): Promise<GuardResult> {
  const cfg = vscode.workspace.getConfiguration("opencodeChat");
  const autoPrompt = cfg.get<boolean>("autoPromptInstall", true);
  const method = cfg.get<string>("installMethod", "auto");

  onPhase("checking", vscode.l10n.t("checking whether OpenCode is available…"));
  const probe = await probeOpencode();
  const probeLine = `[install] probe found=${probe.found} :: ${probe.detail}`;
  output.appendLine(`${stamp()} ${probeLine}`);
  fileLog?.write(probeLine);

  if (probe.found) {
    return { outcome: "available", error: "" };
  }

  const blocked = (why: string): GuardResult => {
    output.appendLine(`${stamp()} [install] ${why} -> se vuelve al boton Launch`);
    fileLog?.write(`[install] ${why}`);
    return { outcome: "blocked", error: "" };
  };

  if (!autoPrompt) {
    return blocked("no encontrado y autoPromptInstall=false");
  }
  if (!ask) {
    return blocked("no encontrado y sin seccion que pueda preguntar");
  }

  // ¿Con qué se instalaría? Se resuelve ANTES de preguntar porque la línea
  // completa forma parte de la pregunta: sin ella el usuario aceptaría a ciegas.
  const installer = await resolveInstaller(method);
  if (!installer) {
    return blocked("no hay ningun gestor de paquetes disponible");
  }
  output.appendLine(`${stamp()} [install] instalador=${installer.id} :: ${installer.command}`);
  fileLog?.write(`[install] instalador=${installer.id}`);

  // Paso 2 — la pregunta, DENTRO de la sección.
  const offer: InstallOffer = {
    message: vscode.l10n.t("OpenCode was not found on your PATH."),
    command: installer.command,
  };
  onPhase("install-pending", "");
  const accepted = await ask(offer);
  fileLog?.write(`[install] respuesta del usuario: ${accepted ? "instalar" : "no"}`);
  if (!accepted) {
    return blocked("el usuario declino instalar");
  }

  // Paso 3 — instalación. El progreso va a la Salida; en la sección se ve la
  // propia barra de estado con su spinner (fase "installing").
  onPhase("installing", installer.command);
  const result = await installOpencode(installer.command, line => {
    output.appendLine(`${stamp()} [install] ${line}`);
    fileLog?.write(`[install] ${line}`);
  });

  const outcomeLine = `[install] fin: ok=${result.ok} ${result.detail}`;
  output.appendLine(`${stamp()} ${outcomeLine}`);
  fileLog?.write(outcomeLine);

  // Paso 4 — re-comprobar. Lo que manda es si `opencode` YA se puede invocar,
  // no el código de salida: npm puede devolver 0 y dejar el binario en un sitio
  // que el shell de arranque no alcanza.
  const after = await probeOpencode();
  output.appendLine(`${stamp()} [install] re-comprobacion found=${after.found} :: ${after.detail}`);
  fileLog?.write(`[install] re-comprobacion found=${after.found}`);

  if (!after.found) {
    const detail = result.detail || vscode.l10n.t("it was installed but is still not on the PATH");
    return {
      outcome: "blocked",
      error: vscode.l10n.t("OpenCode could not be installed ({0}).", detail),
    };
  }
  return { outcome: "blocked", error: "" };
}
