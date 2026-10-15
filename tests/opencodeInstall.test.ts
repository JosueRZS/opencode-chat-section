import "./register";
import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { INSTALLER_CATALOG, NPM_PACKAGE, pickInstaller } from "../src/utils/opencodeInstall";

/**
 * El riesgo real de este archivo no es que falle, sino que funcione DE MAL.
 *
 * Un `opencode-ai` en lugar de `@opencode/cli` sigue instalando algo llamado
 * opencode, pero la v1 congelada; y un `bun install -g` sin `--trust` termina
 * con éxito sin binario. Ninguno de los dos casos produce un error claro, así
 * que quien lo detectaría sería el usuario a las pocas horas. Estos tests
 * bloquean literalmente el texto de los comandos oficiales.
 */
const V2_PACKAGE = "@opencode/cli";

const byId = new Map(INSTALLER_CATALOG.map(s => [s.id, s]));

/** Gestores cuyo comando instala el paquete npm de v2. */
const NPM_LIKE = ["npm", "bun", "pnpm", "yarn"];

describe("catálogo de instaladores", () => {
  test("todos los gestores instalan el paquete de v2, nunca el de v1", () => {
    for (const id of NPM_LIKE) {
      const spec = byId.get(id);
      assert.ok(spec, `falta el instalador ${id}`);
      assert.ok(spec.command.includes(V2_PACKAGE), `${id}: ${spec.command}`);
      assert.equal(NPM_PACKAGE, V2_PACKAGE);
    }
  });

  test("ningún comando menciona opencode-ai, el paquete congelado en v1", () => {
    for (const spec of INSTALLER_CATALOG) {
      assert.ok(
        !spec.command.includes("opencode-ai"),
        `${spec.id} apunta a la v1: ${spec.command}`,
      );
    }
  });

  // Sin este flag bun bloquea el script postinstall que instala el binario
  // nativo: la instalación acaba en verde y el binario no aparece.
  test("bun lleva --trust, sin él el binario nativo se queda fuera", () => {
    assert.ok(byId.get("bun")!.command.includes("bun install -g --trust "));
  });

  // Mismo fallo silencioso que --trust, con el mecanismo de pnpm.
  test("pnpm autoriza expresamente el build del paquete", () => {
    const command = byId.get("pnpm")!.command;
    assert.ok(command.includes(`--allow-build=${V2_PACKAGE}`), command);
    assert.ok(command.includes(`pnpm add -g `), command);
  });

  test("yarn añade el paquete a nivel global", () => {
    assert.ok(byId.get("yarn")!.command.includes("yarn global add "));
  });

  test("el script usa la URL de v2, no la de la v1", () => {
    const command = byId.get("script")!.command;
    assert.ok(command.includes("https://opencode.ai/v2/install"), command);
    assert.ok(!command.includes("https://opencode.ai/install "), command);
    assert.ok(command.includes("| bash"), command);
  });

  test("cada sonda mira el mismo binario que aparece al principio de su comando", () => {
    for (const spec of INSTALLER_CATALOG) {
      assert.ok(spec.command.startsWith(spec.manager + " "), `${spec.id}: ${spec.command}`);
      assert.ok(spec.manager.length > 0, `${spec.id} sin binario que sondear`);
    }
  });

  // Mismos caracteres que en cliCredential: dentro de comillas cmd.exe sigue
  // interpretando «"», «%» y salto de línea, así que no pueden aparecer ni de
  // casualidad en una línea que después se lanza con shell: true.
  test("ningún comando contiene caracteres que la shell reinterpretaría", () => {
    for (const spec of INSTALLER_CATALOG) {
      for (const forbidden of ['"', "%", "\n", "\r"]) {
        assert.ok(
          !spec.command.includes(forbidden),
          `${spec.id} contiene ${JSON.stringify(forbidden)}: ${spec.command}`,
        );
      }
    }
  });

  test("el script no se ofrece en Windows ni brew fuera de macOS", () => {
    assert.deepEqual(byId.get("script")!.platforms, ["darwin", "linux"]);
    assert.deepEqual(byId.get("brew")!.platforms, ["darwin"]);
    // Los gestores de paquetes no restringen plataforma: están donde haya Node.
    for (const id of NPM_LIKE) {
      assert.equal(byId.get(id)!.platforms, undefined, id);
    }
  });

  // El orden de la lista ES la recomendación: el primero disponible es el que
  // se usa en modo auto, así que reordenar esto cambia el comportamiento.
  test("el orden sigue al de la página oficial de descarga", () => {
    assert.deepEqual(
      INSTALLER_CATALOG.map(s => s.id),
      ["npm", "bun", "pnpm", "yarn", "script", "brew"],
    );
  });
});

describe("pickInstaller", () => {
  const TODOS = [
    { id: "npm", command: "npm install -g @opencode/cli" },
    { id: "bun", command: "bun install -g --trust @opencode/cli" },
    { id: "pnpm", command: "pnpm add -g --allow-build=@opencode/cli @opencode/cli" },
  ];
  const SOLO_NPM = [TODOS[0]];

  test("auto elige el primero disponible", () => {
    assert.equal(pickInstaller("auto", TODOS), TODOS[0]);
  });

  test("un gestor pedido que está disponible se respeta", () => {
    assert.equal(pickInstaller("bun", TODOS), TODOS[1]);
  });

  test("un gestor pedido que falta cae en el primero que sí hay", () => {
    // Pedir bun en una máquina sin bun no debe dejar al usuario sin instalación.
    assert.equal(pickInstaller("bun", SOLO_NPM), SOLO_NPM[0]);
  });

  test("cualquier valor desconocido sigue el orden oficial", () => {
    assert.equal(pickInstaller("zig", TODOS), TODOS[0]);
    assert.equal(pickInstaller("", TODOS), TODOS[0]);
  });

  test("sin ningún gestor no se decide nada", () => {
    assert.equal(pickInstaller("auto", []), undefined);
    assert.equal(pickInstaller("npm", []), undefined);
  });

  // `method` viene de la configuración del usuario: aquí sólo se compara contra
  // el id, nunca se concatena. Si fuera al revés, la propia configuración
  // permitiría inyectar una línea en el shell que después corre con shell:true.
  test("una entrada arbitraria no llega jamás al texto del comando", () => {
    const inyeccion = 'bun"; rm -rf ~; echo "';
    const elegido = pickInstaller(inyeccion, TODOS);
    assert.ok(elegido);
    assert.ok(!elegido.command.includes(inyeccion));
    assert.ok(TODOS.some(c => c.command === elegido.command));
  });
});
