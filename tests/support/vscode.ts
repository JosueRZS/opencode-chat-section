import type * as VscodeApi from "vscode";

/**
 * Stub del API de VS Code para tests de lógica pura.
 *
 * `require("vscode")` no existe fuera del extension host, así que
 * `tests/register.ts` redirige ese nombre a ESTE módulo. Como Node cachea por
 * fichero resuelto, el objeto que ve `src/` y el que manipula el test son el
 * mismo — no hay doble instancia.
 *
 * Los exports de nivel superior son la propia API: `import * as vscode from
 * "vscode"` en `src/` recibe este módulo tal cual, así que `vscode.workspace`
 * debe colgar directamente de aquí y no de un export `vscode` anidado.
 *
 * Solo implementa la superficie que la lógica bajo prueba toca de verdad. Si un
 * módulo empieza a usar otra API, falla aquí y no en un test opaco.
 */

/** Estado mutable del falso `vscode`. */
export const state = {
  config: {} as Record<string, Record<string, unknown>>,
  workspaceFolders: undefined as VscodeApi.WorkspaceFolder[] | undefined,
  relativePath: "src/file.ts",
  shell: "/bin/bash",
  activeTextEditor: undefined as VscodeApi.TextEditor | undefined,
  /** Llamadas registradas, para poder asertar sobre ellas. */
  warnings: [] as string[],
  infos: [] as string[],
  l10nCalls: [] as string[],
};

/** Vuelve al estado limpio. Cada test debe llamarlo en `beforeEach`. */
export function reset(): void {
  state.config = {};
  state.workspaceFolders = undefined;
  state.relativePath = "src/file.ts";
  state.shell = "/bin/bash";
  state.activeTextEditor = undefined;
  state.warnings = [];
  state.infos = [];
  state.l10nCalls = [];
}

/** Fija los valores de una sección de configuración (p. ej. `terminal.integrated`). */
export function setConfig(section: string, values: Record<string, unknown>): void {
  state.config[section] = values;
}

export const workspace = {
  getConfiguration(section: string) {
    const values = state.config[section] ?? {};
    return {
      get<T>(key: string, defaultValue?: T): T {
        const found = values[key];
        return (found === undefined ? defaultValue : found) as T;
      },
    };
  },
  get workspaceFolders(): readonly VscodeApi.WorkspaceFolder[] | undefined {
    return state.workspaceFolders;
  },
  asRelativePath(_uri: unknown, _includeWorkspaceFolder?: boolean): string {
    return state.relativePath;
  },
};

export const env = {
  get shell(): string {
    return state.shell;
  },
};

export const window = {
  get activeTextEditor(): VscodeApi.TextEditor | undefined {
    return state.activeTextEditor;
  },
  showWarningMessage(message: string): Thenable<string | undefined> {
    state.warnings.push(message);
    return Promise.resolve(undefined);
  },
  showInformationMessage(message: string): Thenable<string | undefined> {
    state.infos.push(message);
    return Promise.resolve(undefined);
  },
};

/** `l10n.t` sustituye `{0}` por el argumento, como el original. */
export const l10n = {
  t(message: string, ...args: unknown[]): string {
    state.l10nCalls.push(message);
    if (args.length === 0) {
      return message;
    }
    return message.replace(/\{(\d+)\}/g, (_m, index: string) => String(args[Number(index)]));
  },
};
