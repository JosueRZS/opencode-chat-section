import * as vscode from "vscode";
import * as os from "os";
import type { TerminalStyle } from "../shared/terminalStyle";

/**
 * P-029 — Lee la tipografía **real** de la terminal de VS Code para que el xterm
 * de la sección pinte con las mismas métricas y el mismo tamaño que la terminal
 * auténtica del Panel.
 *
 * No hay forma de leerla por CSS: VS Code solo convierte en variables CSS los
 * **colores** (`terminal.ansiBlack`, `terminal.background`, …). Familia, tamaño,
 * interlineado y tracking viven en `terminal.integrated.*`, accesibles solo desde
 * la extensión ⇒ hay que enviárselos al webview por mensaje.
 *
 * Las opciones vacías no significan "vacío" sino **default de plataforma**, así
 * que se replican aquí los defaults de `terminalConfigurationService`.
 */
export function readTerminalStyle(): TerminalStyle {
  const cfg = vscode.workspace.getConfiguration("terminal.integrated");

  const fontFamily = firstNonEmpty(cfg.get<string>("fontFamily")) ?? platformFontFamily();
  const fontSize = numberOr(cfg.get<number>("fontSize"), process.platform === "darwin" ? 12 : 14);

  const cursorStyle = cfg.get<string>("cursorStyle", "block");
  return {
    fontFamily,
    fontSize,
    lineHeight: numberOr(cfg.get<number>("lineHeight"), 1),
    letterSpacing: numberOr(cfg.get<number>("letterSpacing"), 0),
    fontWeight: firstNonEmpty(cfg.get<string>("fontWeight")) ?? "normal",
    fontWeightBold: firstNonEmpty(cfg.get<string>("fontWeightBold")) ?? "bold",
    // `terminal.integrated.cursorBlinking` es la opción real (no `cursorBlink`).
    cursorBlink: cfg.get<boolean>("cursorBlinking", true),
    cursorStyle: cursorStyle === "underline" || cursorStyle === "line" ? cursorStyle : "block",
    scrollback: numberOr(cfg.get<number>("scrollback"), 1000),
  };
}

/** Default de plataforma de `terminal.integrated.fontFamily`. */
function platformFontFamily(): string {
  switch (process.platform) {
    case "darwin":
      return "Menlo, Monaco, 'Courier New', monospace";
    case "win32":
      return "Consolas, 'Courier New', monospace";
    default:
      return "'DejaVu Sans Mono', 'monospace', monospace";
  }
}

function firstNonEmpty(value: string | undefined): string | undefined {
  return value && value.trim() ? value.trim() : undefined;
}

function numberOr(value: number | undefined, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : fallback;
}

/** Para diagnóstico en la pestaña Salida. */
export function describeTerminalStyle(style: TerminalStyle): string {
  return (
    `font=${JSON.stringify(style.fontFamily)} size=${style.fontSize} ` +
    `lh=${style.lineHeight} ls=${style.letterSpacing} weight=${style.fontWeight} ` +
    `cursor=${style.cursorStyle}/${style.cursorBlink} scrollback=${style.scrollback} ` +
    `| vscode.env.shell=${vscode.env.shell} os=${os.platform()}`
  );
}
