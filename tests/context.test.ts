import "./register";
import { test, describe, beforeEach } from "node:test";
import assert from "node:assert/strict";

import type { OpenCodePty } from "../src/terminal/OpenCodePty";
import { buildFileRef, sanitizeForComposer, sendSelection } from "../src/commands/context";
import { reset, state } from "./support/vscode";

interface FakeSelection {
  start: { line: number; character: number };
  end: { line: number; character: number };
  isEmpty: boolean;
}

/** Editor de mentira: `buildFileRef` solo toca `document.uri` y `selection`. */
function editor(selection: FakeSelection) {
  return { document: { uri: {} }, selection } as never;
}

function selection(
  startLine: number,
  startChar: number,
  endLine: number,
  endChar: number,
): FakeSelection {
  return {
    start: { line: startLine, character: startChar },
    end: { line: endLine, character: endChar },
    isEmpty: startLine === endLine && startChar === endChar,
  };
}

beforeEach(reset);

describe("sanitizeForComposer", () => {
  // Cada salto de línea se convertiría en un Enter y el TUI enviaría el mensaje
  // por partes; el compositor debe recibir UNA línea.
  test("cada tipo de salto de línea se convierte en un espacio", () => {
    assert.equal(sanitizeForComposer("uno\ndos"), "uno dos");
    assert.equal(sanitizeForComposer("uno\r\ndos"), "uno dos");
    assert.equal(sanitizeForComposer("uno\rdos"), "uno dos");
    assert.equal(sanitizeForComposer("uno\r\ndos\ntres"), "uno dos tres");
  });

  test("colapsa los espacios y tabuladores repetidos", () => {
    assert.equal(sanitizeForComposer("uno  \t \t dos"), "uno dos");
    assert.equal(sanitizeForComposer("   uno   dos   "), "uno dos");
  });

  test("no toca el texto normal", () => {
    assert.equal(sanitizeForComposer("hola, ¿qué tal?"), "hola, ¿qué tal?");
  });

  test("recorta a 2000 caracteres", () => {
    const long = "x".repeat(3000);
    assert.equal(sanitizeForComposer(long).length, 2000);
    const exact = "y".repeat(2000);
    assert.equal(sanitizeForComposer(exact).length, 2000);
  });
});

describe("buildFileRef", () => {
  beforeEach(() => {
    state.relativePath = "src/file.ts";
  });

  test("sin selección devuelve solo la referencia al fichero", () => {
    assert.equal(buildFileRef(editor(selection(0, 0, 0, 0))), "@src/file.ts");
  });

  // Formato clonado de `getActiveFile()` de la extensión oficial: una sola L
  // para línea única, y la segunda línea SIN L (`#L10-20`, no `#L10-L20`).
  test("una línea única lleva una sola L", () => {
    assert.equal(buildFileRef(editor(selection(9, 0, 9, 5))), "@src/file.ts#L10");
  });

  test("varias líneas llevan L solo en la primera", () => {
    assert.equal(buildFileRef(editor(selection(9, 0, 19, 10))), "@src/file.ts#L10-20");
  });

  // La selección arrastrada a la columna 0 de la línea siguiente NO debe contarla:
  // es lo que produce el clásico `#L10-21` con el ratón.
  test("terminar en la columna 0 de la línea siguiente no suma esa línea", () => {
    assert.equal(buildFileRef(editor(selection(9, 0, 19, 0))), "@src/file.ts#L10-19");
  });

  test("una selección de una línea entera sigue siendo de una línea", () => {
    assert.equal(buildFileRef(editor(selection(9, 0, 10, 0))), "@src/file.ts#L10");
  });

  test("la numeración es de 1, no de 0", () => {
    assert.equal(buildFileRef(editor(selection(0, 0, 0, 3))), "@src/file.ts#L1");
  });
});

describe("sendSelection", () => {
  const pty = {} as OpenCodePty;

  test("sin editor activo avisa y devuelve false sin tocar la PTY", async () => {
    state.activeTextEditor = undefined;
    assert.equal(await sendSelection(pty), false);
    assert.equal(state.warnings.length, 1);
    assert.match(state.warnings[0], /OpenCode/);
    // El aviso sale por l10n, no con el literal del código.
    assert.equal(state.l10nCalls.length, 1);
  });
});
