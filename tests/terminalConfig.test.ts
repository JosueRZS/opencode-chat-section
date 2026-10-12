import "./register";
import { test, describe, beforeEach } from "node:test";
import assert from "node:assert/strict";

import { describeTerminalStyle, readTerminalStyle } from "../src/utils/terminalConfig";
import { reset, setConfig } from "./support/vscode";

beforeEach(reset);

/** Defaults de plataforma que VS Code aplica cuando la opción está vacía. */
const fontFamilyByPlatform: Record<string, string> = {
  darwin: "Menlo, Monaco, 'Courier New', monospace",
  win32: "Consolas, 'Courier New', monospace",
  linux: "'DejaVu Sans Mono', 'monospace', monospace",
};

describe("readTerminalStyle", () => {
  test("con la configuración vacía replica los defaults de plataforma", () => {
    setConfig("terminal.integrated", {});
    const style = readTerminalStyle();
    assert.equal(style.fontFamily, fontFamilyByPlatform[process.platform]);
    assert.equal(style.fontSize, process.platform === "darwin" ? 12 : 14);
    assert.equal(style.lineHeight, 1);
    assert.equal(style.letterSpacing, 0);
    assert.equal(style.fontWeight, "normal");
    assert.equal(style.fontWeightBold, "bold");
    assert.equal(style.cursorBlink, true);
    assert.equal(style.cursorStyle, "block");
    assert.equal(style.scrollback, 1000);
  });

  test("respeta cada valor explícito del usuario", () => {
    setConfig("terminal.integrated", {
      fontFamily: "Fira Code",
      fontSize: 18,
      lineHeight: 1.4,
      letterSpacing: 0.5,
      fontWeight: "500",
      fontWeightBold: "700",
      cursorBlinking: false,
      cursorStyle: "underline",
      scrollback: 500,
    });
    assert.deepEqual(readTerminalStyle(), {
      fontFamily: "Fira Code",
      fontSize: 18,
      lineHeight: 1.4,
      letterSpacing: 0.5,
      fontWeight: "500",
      fontWeightBold: "700",
      cursorBlink: false,
      cursorStyle: "underline",
      scrollback: 500,
    });
  });

  // En VS Code una fontFamily vacía NO significa "sin fuente" sino el default de
  // la plataforma: si aquí se copiara tal cual, xterm caería a otra tipografía.
  test("una fontFamily en blanco cuenta como no fijada", () => {
    setConfig("terminal.integrated", { fontFamily: "   " });
    assert.equal(readTerminalStyle().fontFamily, fontFamilyByPlatform[process.platform]);
  });

  test("un cursorStyle desconocido vuelve a block", () => {
    for (const cursorStyle of ["bogus", "", "BLOC"]) {
      setConfig("terminal.integrated", { cursorStyle });
      assert.equal(readTerminalStyle().cursorStyle, "block");
    }
  });

  test("line y underline se conservan", () => {
    for (const cursorStyle of ["line", "underline"]) {
      setConfig("terminal.integrated", { cursorStyle });
      assert.equal(readTerminalStyle().cursorStyle, cursorStyle);
    }
  });

  test("un tamaño no positivo o no finito cae al default", () => {
    for (const fontSize of [0, -5, Number.NaN, Number.POSITIVE_INFINITY]) {
      setConfig("terminal.integrated", { fontSize });
      assert.equal(readTerminalStyle().fontSize, process.platform === "darwin" ? 12 : 14);
    }
  });

  test("lineHeight 0 cae a 1 y scrollback 0 cae a 1000", () => {
    setConfig("terminal.integrated", { lineHeight: 0, scrollback: 0 });
    const style = readTerminalStyle();
    assert.equal(style.lineHeight, 1);
    assert.equal(style.scrollback, 1000);
  });
});

describe("describeTerminalStyle", () => {
  test("resume cada campo del estilo", () => {
    setConfig("terminal.integrated", { fontFamily: "Fira Code", fontSize: 18, cursorStyle: "line" });
    const line = describeTerminalStyle(readTerminalStyle());
    assert.match(line, /font="Fira Code"/);
    assert.match(line, /size=18/);
    assert.match(line, /cursor=line/);
    assert.match(line, /scrollback=1000/);
    assert.match(line, /os=(win32|darwin|linux)/);
  });
});
