import * as vscode from "vscode";
import * as os from "os";
import * as fs from "fs";
import * as path from "path";

/**
 * P-010 (Fase 0): solo `cmd.exe` rechaza `;` como separador de comandos;
 * PowerShell 5.1 rechaza `&`. El resto (pwsh, bash, zsh, fish, Git Bash) usa `;`.
 *
 * Fuente de verdad: el perfil de terminal por defecto que VS Code aplica a
 * esta plataforma (`terminal.integrated.defaultProfile.<platform>`), con
 * fallback a `vscode.env.shell` si el usuario no tiene perfil explícito.
 */
export function isCmdShell(): boolean {
  return resolveShell().isCmd;
}

export interface ShellSpec {
  /** Binaria a ejecutar (ruta absoluta si la conocemos). */
  file: string;
  /** Argumentos de arranque interactivos (sin comando: `-NoLogo` de PowerShell). */
  args: string[];
  isCmd: boolean;
}

/** Clasifica una ruta de shell por nombre (cmd / powershell / pwsh / otro). */
function classify(shellPath: string): "cmd" | "powershell" | "other" {
  const base = path.basename(shellPath).toLowerCase();
  if (/^cmd(\.exe)?$/.test(base)) {
    return "cmd";
  }
  if (/^(powershell|pwsh)(\.exe)?$/.test(base)) {
    return "powershell";
  }
  return "other";
}

/** Expande `${env:VAR}` (estilo VS Code) y `~` en la ruta de un perfil. */
function expandProfilePath(raw: string): string {
  let value = raw.replace(/\$\{env:([^}]+)\}/g, (_, name: string) => process.env[name] ?? "");
  if (value === "~" || value.startsWith("~/") || value.startsWith("~\\")) {
    value = os.homedir() + value.slice(1);
  }
  return value;
}

/**
 * Resuelve el shell **interactivo** que VS Code usaría en esta plataforma.
 * Se usa para alojar la PTY de OpenCode: arrancamos el shell y le tecleamos
 * el comando (P-001: nunca `shellPath: 'opencode'` — el PATH del extension
 * host no es el del usuario).
 */
export function resolveShell(): ShellSpec {
  const platform =
    process.platform === "win32" ? "windows" : process.platform === "darwin" ? "osx" : "linux";
  const cfg = vscode.workspace.getConfiguration("terminal.integrated");
  const profileName = cfg.get<string>(`defaultProfile.${platform}`);
  const profiles =
    cfg.get<Record<string, { path?: string; args?: string[] }>>(`profiles.${platform}`) ?? {};
  const profilePath = profileName ? profiles[profileName]?.path : undefined;

  if (process.platform === "win32") {
    const candidate = profilePath ? expandProfilePath(profilePath) : undefined;
    if (candidate && classify(candidate) === "powershell") {
      // -NoLogo: evita el banner para que el TUI arranque más limpio.
      return { file: candidate, args: ["-NoLogo"], isCmd: false };
    }
    if (candidate && classify(candidate) === "cmd") {
      return { file: candidate, args: [], isCmd: true };
    }
    // Sin perfil reconocido → PowerShell (default real de VS Code en Windows),
    // y si tampoco existe, COMSPEC/cmd.exe como último recurso.
    const ps = "C:\\WINDOWS\\System32\\WindowsPowerShell\\v1.0\\powershell.exe";
    if (fs.existsSync(ps)) {
      // -NoLogo: evita el banner para que el TUI arranque más limpio.
      return { file: ps, args: ["-NoLogo"], isCmd: false };
    }
    return { file: process.env.COMSPEC || "cmd.exe", args: [], isCmd: true };
  }

  const candidate =
    (profilePath ? expandProfilePath(profilePath) : undefined) ||
    vscode.env.shell ||
    process.env.SHELL ||
    "/bin/bash";
  return { file: candidate, args: [], isCmd: false };
}

/**
 * PATH del hijo: añade los directorios estándar de npm global por si el PATH
 * del extension host no los incluye (P-001), y conserva el PATH heredado.
 */
export function envWithPath(): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = { ...process.env };
  const extra: string[] = [];

  if (process.platform === "win32") {
    if (process.env.APPDATA) {
      extra.push(path.join(process.env.APPDATA, "npm"));
    }
    if (process.env.ProgramFiles) {
      extra.push(path.join(process.env.ProgramFiles, "nodejs"));
    }
  } else {
    const home = os.homedir();
    extra.push(path.join(home, ".npm-global", "bin"), path.join(home, ".local", "bin"), "/usr/local/bin");
  }

  const current = env.PATH ?? env.Path ?? "";
  env.PATH = [...extra, current].filter(Boolean).join(path.delimiter);
  return env;
}

/**
 * Comando que se le "teclea" al shell dentro de la PTY.
 * `chainExit` (§7.3) hace que la PTY muera con el TUI: la sección vuelve al
 * botón Launch. Sin él, queda el prompt del shell (fallback útil).
 *
 * P-024: el separador se decide por el shell REAL que se va a arrancar, no por
 * `isCmdShell()`. Además, con cmd.exe `&` **NO** es separador de dos comandos:
 * `opencode & exit` pasa `"exit"` como argumento posicional a OpenCode →
 * `ERROR Unexpected positional argument: "exit"` → el TUI nunca arranca.
 *
 * Solución robusta y agnóstica: se escribe `opencode\r` (el TUI toma el
 * control) y `exit` se envía por separado **solo cuando el TUI muere**
 * (§7.3): la extensión detecta `onExit` de la PTY… no, al revés: la PTY debe
 * morir CON el TUI. Como el TUI controla la consola, no podemos encadenar
 * `exit` detrás. La vía correcta y probada es enviar el comando en su propia
 * línea y dejar que `chainExit` escriba `exit` tras el primer dato de salida.
 */
export function buildOpencodeCommand(chainExit: boolean): string {
  const configured = vscode.workspace
    .getConfiguration("opencodeChat")
    .get<string>("cliPath", "opencode");
  const cli = configured && configured.trim() ? configured.trim() : "opencode";
  // Si la ruta tiene espacios, cmd/powershell necesitan comillas.
  const needsQuotes = /\s/.test(cli);
  const command = needsQuotes ? `"${cli}"` : cli;

  if (!chainExit) {
    return command;
  }
  // P-024: NUNCA encadenar `exit` detrás del comando.
  // - cmd.exe: `&`/`;` no separan dos comandos; `exit` acaba como argumento.
  // - PowerShell: `;` sí separa, pero OpenCode (Cobra) parsea `exit` como
  //   positional y aborta con `Unexpected positional argument`.
  // Se envía el comando solo y la PTY se cierra por `onExit` del propio shell
  // cuando el usuario escriba `exit`, o vía `dispose()`/`newSession()`.
  return command;
}

/** Resuelve `terminalCwd`: soporta `${workspaceFolder}` y `~`. */
export function resolveCwd(value?: string): string | undefined {
  if (!value || !value.trim()) {
    return undefined;
  }
  const folder = vscode.workspace.workspaceFolders?.[0];
  let resolved = value.replace(/\$\{workspaceFolder\}/g, folder?.uri.fsPath ?? "");
  if (resolved === "~" || resolved.startsWith("~/") || resolved.startsWith("~\\")) {
    const home = os.homedir();
    resolved = home + resolved.slice(1);
  }
  resolved = resolved.trim();
  return resolved.length > 0 ? resolved : undefined;
}
