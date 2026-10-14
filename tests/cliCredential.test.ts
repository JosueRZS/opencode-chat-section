import "./register";
import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { buildAuthExportCommand, parseAuthExport } from "../src/usage/cliCredential";

/** Salida real de `opencode auth export`, con la clave recortada. */
const REAL = JSON.stringify([
  {
    id: "cred00000000000000000000000000",
    integrationID: "opencode",
    label: "OpenCode Console",
    active: true,
    value: { type: "key", key: "sk-" + "a".repeat(64) },
  },
]);

describe("parseAuthExport", () => {
  test("lee la clave de la salida real", () => {
    assert.equal(parseAuthExport(REAL), "sk-" + "a".repeat(64));
  });

  test("prefiere la credencial activa cuando hay varias", () => {
    const salida = JSON.stringify([
      { id: "a", active: false, value: { type: "key", key: "PRIMERA" } },
      { id: "b", active: true, value: { type: "key", key: "ACTIVA" } },
      { id: "c", active: false, value: { type: "key", key: "TERCERA" } },
    ]);
    assert.equal(parseAuthExport(salida), "ACTIVA");
  });

  // Sin ninguna marcada activa, el CLI usa la primera por defecto: seguir esa
  // misma convención evita que la extensión elija otra cuenta que la TUI.
  test("con ninguna activa usa la primera", () => {
    const salida = JSON.stringify([
      { id: "a", value: { type: "key", key: "PRIMERA" } },
      { id: "b", value: { type: "key", key: "SEGUNDA" } },
    ]);
    assert.equal(parseAuthExport(salida), "PRIMERA");
  });

  test("tolera los avisos que el CLI escriba antes del JSON", () => {
    const conAviso = "WARN algo se ve raro\n" + REAL;
    assert.equal(parseAuthExport(conAviso), "sk-" + "a".repeat(64));
  });

  test("tolera campos desconocidos y otras credenciales de otras integraciones", () => {
    const salida = JSON.stringify([
      { id: "x", active: true, value: { type: "key", key: "K1" }, extra: { nested: 1 } },
      { id: "y", integrationID: "github", active: true, value: { type: "oauth", token: "T" } },
    ]);
    assert.equal(parseAuthExport(salida), "K1");
  });

  test("devuelve undefined cuando no hay nada utilizable", () => {
    const inutiles: Array<[string, string]> = [
      ["vacío", ""],
      ["sin corchete", "no hay credenciales guardadas"],
      ["JSON roto", '[{"active": true, "value":'],
      ["no es un array", '{"value":{"key":"K"}}'],
      ["sin value", '[{"active": true}]'],
      ["value sin key", '[{"active": true, "value": {"type":"key"}}]'],
      ["key vacía", '[{"active": true, "value": {"key": ""}}]'],
      ["key no textual", '[{"active": true, "value": {"key": 12345}}]'],
      ["array vacío", "[]"],
      ["elemento no objeto", '["texto"]'],
    ];
    for (const [nombre, salida] of inutiles) {
      assert.equal(parseAuthExport(salida), undefined, `${nombre} debió rechazarse`);
    }
  });
});

describe("buildAuthExportCommand", () => {
  test("un nombre suelto no lleva comillas", () => {
    assert.equal(buildAuthExportCommand("opencode"), "opencode auth export");
  });

  // Sin comillas cmd.exe se para en el primer espacio y lanza solo la mitad de
  // la ruta: el fallo es silencioso (ENOENT), no un error claro.
  test("una ruta con espacios va entrecomillada", () => {
    const ruta = "C:\\Users\\A B\\AppData\\Roaming\\npm\\opencode.cmd";
    assert.equal(buildAuthExportCommand(ruta), `"${ruta}" auth export`);
  });

  test("recorta los espacios sobrantes de la configuración", () => {
    assert.equal(buildAuthExportCommand("  opencode  "), "opencode auth export");
  });

  // `"` rompe la comilla de cmd.exe y permite continuar la línea: es la vía
  // clásica de inyección. Sin escapable posible, se rechaza la ruta entera.
  test("rechaza rutas con comillas dobles", () => {
    assert.equal(buildAuthExportCommand('opencode" & echo PWNED & rem "'), undefined);
  });

  // `%` expande variables dentro de comillas en cmd.exe, así que una ruta con
  // `%` puede reescribirse por el entorno antes de ejecutarse.
  test("rechaza rutas con signo de porcentaje", () => {
    assert.equal(buildAuthExportCommand("%SystemRoot%\\opencode.cmd"), undefined);
  });

  test("rechaza rutas con saltos de línea", () => {
    assert.equal(buildAuthExportCommand("opencode.cmd\n& del /q C:\\x"), undefined);
  });

  test("rechaza la ruta vacía", () => {
    assert.equal(buildAuthExportCommand(""), undefined);
    assert.equal(buildAuthExportCommand("   "), undefined);
  });

  test("entrecomilla los metacaracteres de cmd.exe", () => {
    const ruta = "C:\\Archivos (x86)\\opencode.cmd";
    assert.equal(buildAuthExportCommand(ruta), `"${ruta}" auth export`);
  });
});
