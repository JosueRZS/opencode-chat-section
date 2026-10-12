/**
 * Estilo tipográfico de la terminal de VS Code, compartido por la extensión
 * (que lo LEE de la configuración) y por el webview (que lo APLICA a xterm.js).
 *
 * Solo la interfaz: vive fuera de `src/webview` porque el cliente no puede
 * importar `vscode`, y no debe arrastrar `process` (no existe en el navegador).
 *
 * Por qué hace falta: las fuentes NO son colores, así que VS Code **no** expone
 * `--vscode-terminal-font-family` ni similares a los webviews (solo registra
 * variables CSS para colores: `terminal.ansiBlack`, `terminal.background`, …).
 * La única vía es leer `terminal.integrated.*` en la extensión y enviárselo al
 * cliente. Sin esto, xterm cae a la tipografía del EDITOR y el banner ASCII sale
 * con métricas distintas a las de la terminal real (P-029).
 */
export interface TerminalStyle {
  fontFamily: string;
  fontSize: number;
  /** `terminal.integrated.lineHeight` (xterm lo usa como multiplicador). */
  lineHeight: number;
  /** `terminal.integrated.letterSpacing` en píxeles. */
  letterSpacing: number;
  fontWeight: string;
  fontWeightBold: string;
  cursorBlink: boolean;
  cursorStyle: "block" | "underline" | "line";
  scrollback: number;
}
