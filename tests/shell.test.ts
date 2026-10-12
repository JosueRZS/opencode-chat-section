import "./register";
import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import * as os from "os";
import * as fs from "fs";
import * as path from "path";

import {
  buildOpencodeCommand,
  envWithPath,
  isCmdShell,
  opencodeTuiEnv,
  resolveCwd,
  resolveShell,
} from "../src/utils/shell";
import { reset, setConfig, state } from "./support/vscode";

/** Solo tiene sentido comprobar las ramas de la plataforma en la que corremos. */
const onWindows = process.platform === "win32";
const WINDOWS_PS = "C:\\WINDOWS\\System32\\WindowsPowerShell\\v1.0\\powershell.exe";

function setProfiles(platform: string, name: string, profilePath: string, args?: string[]): void {
  setConfig("terminal.integrated", {
    [`defaultProfile.${platform}`]: name,
    [`profiles.${platform}`]: { [name]: { path: profilePath, ...(args ? { args } : {}) } },
  });
}

beforeEach(reset);

describe("resolveShell", () => {
  test("un perfil de PowerShell lleva -NoLogo y no es cmd", { skip: !onWindows }, () => {
    const exe = "C:/Windows/System32/WindowsPowerShell/v1.0/powershell.exe";
    setProfiles("windows", "PowerShell", exe);
    assert.deepEqual(resolveShell(), { file: exe, args: ["-NoLogo"], isCmd: false });
  });

  test("un perfil de pwsh se clasifica igual que powershell", { skip: !onWindows }, () => {
    const exe = "C:/Program Files/PowerShell/7/pwsh.exe";
    setProfiles("windows", "pwsh", exe);
    assert.deepEqual(resolveShell(), { file: exe, args: ["-NoLogo"], isCmd: false });
  });

  test("un perfil de cmd va sin argumentos y con isCmd", { skip: !onWindows }, () => {
    const exe = "C:/Windows/System32/cmd.exe";
    setProfiles("windows", "Command Prompt", exe);
    assert.deepEqual(resolveShell(), { file: exe, args: [], isCmd: true });
  });

  test("expande ${env:VAR} en la ruta del perfil", { skip: !onWindows }, () => {
    // Concatena, no normaliza: conserva las barras que el usuario escribió.
    const expected =
      (process.env.SystemRoot ?? "C:\\Windows") + "/System32/WindowsPowerShell/v1.0/powershell.exe";
    setProfiles("windows", "PS", "${env:SystemRoot}/System32/WindowsPowerShell/v1.0/powershell.exe");
    assert.equal(resolveShell().file, expected);
  });

  test("expande ~ en la ruta del perfil", { skip: !onWindows }, () => {
    setProfiles("windows", "PS", "~/bin/pwsh.exe");
    assert.equal(resolveShell().file, os.homedir() + "/bin/pwsh.exe");
  });

  test("un perfil no reconocido cae al PowerShell real de la máquina", { skip: !onWindows }, () => {
    setProfiles("windows", "Git Bash", "C:/Program Files/Git/bin/bash.exe");
    const expected = fs.existsSync(WINDOWS_PS)
      ? { file: WINDOWS_PS, args: ["-NoLogo"], isCmd: false }
      : { file: process.env.COMSPEC || "cmd.exe", args: [], isCmd: true };
    assert.deepEqual(resolveShell(), expected);
  });

  test("isCmdShell es coherente con lo que devuelve resolveShell", () => {
    setConfig("terminal.integrated", {});
    assert.equal(isCmdShell(), resolveShell().isCmd);
  });
});

describe("buildOpencodeCommand", () => {
  test("usa el valor por defecto cuando no hay ajuste", () => {
    assert.equal(buildOpencodeCommand(false), "opencode");
  });

  // P-024: la regresión que rompía el TUI por completo. Con `chainExit` el
  // comando debe salir SOLO: con cmd.exe `exit` acababa como argumento posicional
  // de OpenCode y Cobra abortaba antes de pintar nada.
  test("NUNCA encadena exit tras el comando, ni con chainExit activo", () => {
    setConfig("opencodeChat", { cliPath: "opencode" });
    for (const chain of [true, false]) {
      const command = buildOpencodeCommand(chain);
      assert.equal(command, "opencode");
      assert.ok(!command.includes("exit"), `no debe contener 'exit': ${command}`);
      assert.ok(!/[;&|]/.test(command), `no debe contener separadores: ${command}`);
    }
  });

  test("comillona la ruta si tiene espacios", () => {
    setConfig("opencodeChat", { cliPath: "C:\\Program Files\\opencode\\bin\\opencode.exe" });
    assert.equal(buildOpencodeCommand(false), '"C:\\Program Files\\opencode\\bin\\opencode.exe"');
  });

  test("una ruta sin espacios no se comillona", () => {
    setConfig("opencodeChat", { cliPath: "C:\\tools\\opencode.exe" });
    assert.equal(buildOpencodeCommand(false), "C:\\tools\\opencode.exe");
  });

  test("un cliPath en blanco vuelve al valor por defecto", () => {
    setConfig("opencodeChat", { cliPath: "    " });
    assert.equal(buildOpencodeCommand(false), "opencode");
  });

  test("recorta los espacios alrededor de la ruta", () => {
    setConfig("opencodeChat", { cliPath: "  opencode  " });
    assert.equal(buildOpencodeCommand(false), "opencode");
  });
});

describe("resolveCwd", () => {
  beforeEach(() => {
    state.workspaceFolders = [{ uri: { fsPath: "C:/wsp/proj" } }] as never;
  });

  test("vacío o indefinido devuelve undefined", () => {
    for (const value of [undefined, "", "   "]) {
      assert.equal(resolveCwd(value), undefined);
    }
  });

  test("sustituye ${workspaceFolder}", () => {
    assert.equal(resolveCwd("${workspaceFolder}"), "C:/wsp/proj");
    assert.equal(resolveCwd("${workspaceFolder}/src"), "C:/wsp/proj/src");
  });

  test("con ${workspaceFolder} y sin carpetas el resultado vacío se descarta", () => {
    state.workspaceFolders = undefined;
    assert.equal(resolveCwd("${workspaceFolder}"), undefined);
    assert.equal(resolveCwd("${workspaceFolder}/src"), "/src");
  });

  test("expande ~ a HOME conservando el separador escrito", () => {
    assert.equal(resolveCwd("~"), os.homedir());
    assert.equal(resolveCwd("~/x"), os.homedir() + "/x");
    assert.equal(resolveCwd("~\\x"), os.homedir() + "\\x");
  });

  // La expansión de ~ ocurre ANTES de recortar, así que un valor con espacios
  // delante no se reconoce como ruta de HOME. Se fija aquí a propósito: es el
  // contrato real de la función, no un ideal.
  test("~ solo se expande si el valor empieza por tilde", () => {
    assert.equal(resolveCwd("~/x  "), os.homedir() + "/x");
    assert.equal(resolveCwd("  ~/x"), "~/x");
  });

  test("una ruta literal pasa tal cual", () => {
    assert.equal(resolveCwd("C:/otro"), "C:/otro");
  });

  test("el recorte se aplica al resultado", () => {
    assert.equal(resolveCwd("  C:/otro  "), "C:/otro");
  });
});

describe("opencodeTuiEnv", () => {
  /** P-030: la variable va SOLO a nuestra PTY; nada más debe salir de aquí. */
  function injected(): Record<string, unknown> {
    const env = opencodeTuiEnv();
    assert.deepEqual(Object.keys(env), ["OPENCODE_CLI_CONFIG_CONTENT"]);
    return JSON.parse(env.OPENCODE_CLI_CONFIG_CONTENT) as Record<string, unknown>;
  }

  test("por defecto desactiva la barra de pestañas", () => {
    setConfig("opencodeChat", {});
    assert.deepEqual(injected(), { tabs: { mode: "off" } });
  });

  test("modo auto y on pasan sin tocar", () => {
    for (const mode of ["auto", "on"]) {
      setConfig("opencodeChat", { tuiTabs: mode });
      assert.deepEqual(injected(), { tabs: { mode } });
    }
  });

  test("un valor desconocido vuelve a off", () => {
    setConfig("opencodeChat", { tuiTabs: "banana" });
    assert.deepEqual(injected(), { tabs: { mode: "off" } });
  });

  test("el contenido es JSON válido y solo lleva tabs", () => {
    setConfig("opencodeChat", { tuiTabs: "auto" });
    const parsed = injected();
    assert.deepEqual(Object.keys(parsed), ["tabs"]);
    assert.equal(typeof parsed.tabs, "object");
  });
});

describe("envWithPath", () => {
  const originalPath = process.env.PATH;

  beforeEach(() => {
    process.env.PATH = "C:\\base-original";
  });

  afterEach(() => {
    process.env.PATH = originalPath;
  });

  test("conserva el PATH heredado al final", () => {
    const value = envWithPath().PATH ?? "";
    assert.ok(value.endsWith("C:\\base-original"), value);
  });

  test("el PATH sigue siendo una cadena, no un array", () => {
    assert.equal(typeof envWithPath().PATH, "string");
  });

  test("incluye npm global y nodejs en Windows", { skip: !onWindows }, () => {
    const value = envWithPath().PATH ?? "";
    assert.ok(value.includes(path.join(process.env.APPDATA ?? "", "npm")), value);
    assert.ok(value.includes(path.join(process.env.ProgramFiles ?? "", "nodejs")), value);
  });

  // El instalador por script mete el binario en ~/.opencode/bin escribiéndolo en
  // los .bashrc: sin añadirlo aquí la instalación quedaría invisible para la PTY.
  test("~/.opencode/bin entra solo si existe de verdad", () => {
    const value = envWithPath().PATH ?? "";
    const officialBin = path.join(os.homedir(), ".opencode", "bin");
    assert.equal(value.includes(officialBin), fs.existsSync(officialBin), value);
  });

  test("no toca el resto de variables de entorno", () => {
    process.env.OPENCODE_TEST_SENTINEL = "1";
    try {
      assert.equal(envWithPath().OPENCODE_TEST_SENTINEL, "1");
    } finally {
      delete process.env.OPENCODE_TEST_SENTINEL;
      process.env.PATH = originalPath;
    }
  });
});
