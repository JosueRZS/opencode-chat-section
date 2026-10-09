import * as vscode from "vscode";

/**
 * P-010 (Fase 0): solo `cmd.exe` rechaza `;` como separador de comandos;
 * PowerShell 5.1 rechaza `&`. El resto (pwsh, bash, zsh, fish, Git Bash) usa `;`.
 *
 * Fuente de verdad: el perfil de terminal por defecto que VS Code aplica a
 * esta plataforma (`terminal.integrated.defaultProfile.<platform>`), con
 * fallback a `vscode.env.shell` si el usuario no tiene perfil explícito.
 */
export function isCmdShell(): boolean {
  const platform =
    process.platform === "win32" ? "windows" : process.platform === "darwin" ? "osx" : "linux";
  const cfg = vscode.workspace.getConfiguration("terminal.integrated");

  const profileName = cfg.get<string>(`defaultProfile.${platform}`);
  if (profileName) {
    const profiles = cfg.get<Record<string, { path?: string }>>(`profiles.${platform}`) ?? {};
    const profile = profiles[profileName];
    const path = (profile?.path ?? "").toLowerCase();
    if (path) {
      // `${env:windir}\System32\cmd.exe`, `cmd.exe`, `cmd`…
      return /(^|[\\/])cmd(\.exe)?$/.test(path);
    }
    // Perfil sin path explícito (p. ej. "Command Prompt"): decidir por nombre.
    return /command prompt|^cmd$/i.test(profileName);
  }

  // Sin perfil declarado → usar el shell de la sesión de VS Code.
  const shell = (vscode.env.shell ?? "").toLowerCase();
  return shell.includes("cmd.exe");
}
