import { execFile } from "child_process";
import { envWithPath } from "../utils/shell";

/**
 * Credencial que el CLI de OpenCode ya tiene guardada.
 *
 * Motivo de existir: sin esto, el indicador de uso pediría al usuario una API
 * key que el propio CLI ya posee — reconfiguración pura. `opencode auth export`
 * es el mandato oficial para leerla («print stored credentials, including
 * secrets, as JSON»), de solo lectura y sin acoplar a ningún esquema.
 *
 * Por qué se lanza un proceso en vez de leer el disco: la credencial vive en la
 * tabla `credential` de `opencode.db`, un SQLite **bloqueado** por el servicio
 * que corre en segundo plano, y leerlo exigiría añadir un driver nativo y
 * acoplarse a un esquema sin garantía de estabilidad. El mandato del CLI no
 * tiene ninguno de esos problemas.
 *
 * Coste medido en esta máquina: 612–1038 ms. Con un refresco cada 15 minutos es
 * irrelevante, y se memoiza para no pagarlo dos veces seguidas.
 */

const SPAWN_TIMEOUT_MS = 20_000;

/**
 * Construye la línea de `auth export` para pasarla por el shell de Windows.
 *
 * Devuelve `undefined` cuando la ruta no puede dejarse inocua. En cmd.exe hay
 * exactamente dos caracteres que siguen siendo especiales DENTRO de comillas:
 *
 *   - `"` cierra la comilla y permite continuar la línea con otro comando;
 *   - `%` expande variables aunque esté entrecomillado.
 *
 * Con uno de los dos dentro no hay forma de cotear, así que se rechaza en
 * cuanto se detecta: mejor no leer la credencial que inyectar algo.
 *
 * Se construye el comando COMPLETO aquí y se pasa con `args` vacío a
 * `execFile`, porque Node solo emite el aviso `DEP0190` —argumentos sin escapar
 * en un hijo con shell— cuando hay argumentos que concatenar. Construyéndolo
 * nosotros no queda nada que concatenar, y el escaping es nuestro.
 */
export function buildAuthExportCommand(cliPath: string): string | undefined {
  const trimmed = cliPath.trim();
  if (!trimmed || /["%]/.test(trimmed) || /[\r\n]/.test(trimmed)) {
    return undefined;
  }
  // Con espacios o metacaracteres de cmd.exe, la ruta va entrecomillada; sin
  // ellos, comillas de más solo estorban (y un `.cmd` resuelto por PATH se
  // pierde si se envuelve).
  const needsQuotes = /[\s&^(){}[\];,!]/.test(trimmed);
  return needsQuotes ? `"${trimmed}" auth export` : `${trimmed} auth export`;
}

function isRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/**
 * Extrae la clave de la salida de `opencode auth export`.
 *
 * Tolera lo que el CLI pueda escribir antes del JSON (avisos, marcado ANSI):
 * el array es lo primero que aparece, y si no lo hay no hay credencial.
 *
 * Entre varias credenciales se elige la **activa**; si ninguna lo está, la
 * primera, que es como el propio CLI resuelve su cuenta por defecto.
 */
export function parseAuthExport(stdout: string): string | undefined {
  const start = stdout.indexOf("[");
  if (start < 0) {
    return undefined;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout.slice(start));
  } catch {
    return undefined;
  }
  if (!Array.isArray(parsed)) {
    return undefined;
  }
  const entries = parsed.map(isRecord).filter((e): e is Record<string, unknown> => e !== undefined);
  const chosen = entries.find(entry => entry.active === true) ?? entries[0];
  const value = chosen ? isRecord(chosen.value) : undefined;
  const key = value?.key;
  return typeof key === "string" && key.length > 0 ? key : undefined;
}

/**
 * Lee la credencial del CLI. Resuelve `undefined` —nunca rechaza— cuando no
 * hay: que el CLI falte no es un error de la extensión, es un estado.
 *
 * En Windows el binario de npm es un `.cmd`, que Node ya no deja lanzar sin
 * shell (`EINVAL`, CVE-2024-27980), así que se va por shell con el comando
 * ya construido. En el resto de plataformas el binario es ejecutable y se
 * lanza directo, sin shell y sin posibilidad de interpretación.
 */
export function readCliCredential(cliPath: string): Promise<string | undefined> {
  return new Promise(resolve => {
    const done = (error: Error | null, stdout: string): void => {
      // Un fallo aquí no se propaga: `usageStatus` simplemente no pinta el indicador.
      resolve(error ? undefined : parseAuthExport(stdout));
    };

    if (process.platform === "win32") {
      const command = buildAuthExportCommand(cliPath);
      if (!command) {
        resolve(undefined);
        return;
      }
      execFile(
        command,
        [],
        {
          shell: true,
          env: envWithPath(),
          timeout: SPAWN_TIMEOUT_MS,
          maxBuffer: 1024 * 1024,
          windowsHide: true,
          encoding: "utf8",
        },
        done,
      );
      return;
    }

    execFile(
      cliPath,
      ["auth", "export"],
      {
        env: envWithPath(),
        timeout: SPAWN_TIMEOUT_MS,
        maxBuffer: 1024 * 1024,
        windowsHide: true,
        encoding: "utf8",
      },
      done,
    );
  });
}
