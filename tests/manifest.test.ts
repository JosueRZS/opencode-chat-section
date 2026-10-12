import "./register";
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as path from "path";

import { CHAT_CONTAINER_ID, STATUS_VIEW_ID } from "../src/utils/placement";

const root = path.join(__dirname, "..", "..");
const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")) as {
  main?: string;
  l10n?: string;
  publisher?: string;
  engines?: { vscode?: string };
  extensionKind?: string[];
  capabilities?: { untrustedWorkspaces?: { supported?: boolean }; virtualWorkspaces?: { supported?: boolean } };
  activationEvents?: string[];
  contributes: {
    commands?: { command: string }[];
    keybindings?: { command: string; key: string }[];
    menus?: Record<string, { command: string }[]>;
    views?: Record<string, { id: string; name: string; type?: string }[]>;
  };
};
const nls = JSON.parse(fs.readFileSync(path.join(root, "package.nls.json"), "utf8")) as Record<string, string>;
const nlsEs = JSON.parse(
  fs.readFileSync(path.join(root, "package.nls.es.json"), "utf8"),
) as Record<string, string>;

const commands = pkg.contributes.commands ?? [];

/** Toda `%clave%` del manifest debe existir en ambos idiomas. */
function localizedRefs(): string[] {
  const text = JSON.stringify(pkg);
  return [...new Set(text.match(/%[\w.]+%/g) ?? [])].map(key => key.slice(1, -1));
}

describe("manifest: localización del manifest", () => {
  test("todo %key% referenciado existe en inglés y en español", () => {
    const refs = localizedRefs();
    assert.ok(refs.length > 0, "no se localizó ningún título ni descripción");
    for (const ref of refs) {
      assert.ok(ref in nls, `falta en package.nls.json: ${ref}`);
      assert.ok(ref in nlsEs, `falta en package.nls.es.json: ${ref}`);
    }
  });

  test("los dos bundles llevan exactamente las mismas claves", () => {
    assert.deepEqual(Object.keys(nls).sort(), Object.keys(nlsEs).sort());
  });

  test("ninguna clave sobra sin usarse en el manifest", () => {
    const refs = localizedRefs();
    for (const key of Object.keys(nls)) {
      assert.ok(refs.includes(key), `clave sobrante en los bundles: ${key}`);
    }
  });

  test("ningún texto inglés se queda sin traducir", () => {
    for (const [key, value] of Object.entries(nls)) {
      assert.ok(value.trim().length > 0, `traducción vacía para ${key}`);
    }
    for (const [key, value] of Object.entries(nlsEs)) {
      assert.ok(value.trim().length > 0, `traducción vacía para ${key}`);
    }
  });
});

describe("manifest: identidad y alcance", () => {
  test("main apunta al bundle generado", () => {
    assert.equal(pkg.main, "./dist/extension.js");
  });

  test("l10n apunta al directorio de bundles", () => {
    assert.equal(pkg.l10n, "./l10n");
  });

  test("engines.vscode es un semver con caret", () => {
    assert.match(pkg.engines?.vscode ?? "", /^\^\d+\.\d+\.?\d*$/);
  });

  test("es una extensión de UI, no de workspace", () => {
    assert.ok(pkg.extensionKind?.includes("ui"), JSON.stringify(pkg.extensionKind));
  });

  test("declara explícitamente que no corre en workspaces restringidos ni virtuales", () => {
    assert.equal(pkg.capabilities?.untrustedWorkspaces?.supported, false);
    assert.equal(pkg.capabilities?.virtualWorkspaces?.supported, false);
  });
});

describe("manifest: activación", () => {
  // VS Code ya genera los `onView:` a partir de `contributes.views`; declararlos
  // a mano duplica la activación sin aportar nada (decisión explícita del usuario).
  test("no hay eventos onView redundantes", () => {
    const events = pkg.activationEvents ?? [];
    for (const event of events) {
      assert.ok(!event.startsWith("onView:"), `evento onView redundante: ${event}`);
    }
  });

  test("la única activación es onStartupFinished", () => {
    assert.deepEqual(pkg.activationEvents, ["onStartupFinished"]);
  });
});

describe("manifest: comandos y atajos", () => {
  test("todos los comandos usan el prefijo opencodeChat.", () => {
    for (const { command } of commands) {
      assert.match(command, /^opencodeChat\./, command);
    }
  });

  test("los atajos solo apuntan a comandos declarados", () => {
    const ids = new Set(commands.map(({ command }) => command));
    for (const binding of pkg.contributes.keybindings ?? []) {
      assert.ok(ids.has(binding.command), `atajo sin comando declarado: ${binding.command}`);
    }
  });

  test("los menús solo apuntan a comandos declarados", () => {
    const ids = new Set(commands.map(({ command }) => command));
    for (const [location, items] of Object.entries(pkg.contributes.menus ?? {})) {
      for (const item of items) {
        assert.ok(ids.has(item.command), `menú ${location} con comando desconocido: ${item.command}`);
      }
    }
  });

  // D2: son los cinco atajos acordados, sin colisión con la extensión oficial.
  test("los atajos son exactamente los acordados y no se solapan entre sí", () => {
    const keys = (pkg.contributes.keybindings ?? []).map(binding => binding.key);
    assert.deepEqual(keys.sort(), ["ctrl+alt+enter", "ctrl+alt+k", "ctrl+alt+n", "ctrl+alt+o", "ctrl+alt+shift+o"]);
    assert.equal(new Set(keys).size, keys.length, "hay atajos duplicados");
  });
});

describe("manifest: la vista", () => {
  const views = pkg.contributes.views?.explorer ?? [];

  test("hay una sola vista, declarada en explorer (P-019)", () => {
    assert.equal(views.length, 1);
    assert.equal(views[0].id, STATUS_VIEW_ID);
    assert.equal(views[0].type, "webview");
  });

  // Si el id del manifest y el de placement.ts dejan de coincidir, la colocación
  // en caliente falla en silencio y la sección no aparece bajo Chat.
  test("el id del manifest es el mismo que usa placement", () => {
    assert.equal(views[0].id, STATUS_VIEW_ID);
  });

  // El contenedor de Chat tiene longitud fija en el registro core: cualquier otra
  // cadena da "contenedor no existe" y el movimiento en caliente no llega a ocurrir.
  test("el contenedor de Chat sigue siendo workbench.panel.chat", () => {
    assert.equal(CHAT_CONTAINER_ID, "workbench.panel.chat");
  });
});
