import { test, describe } from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as path from "path";

const root = path.join(__dirname, "..", "..");
const bundle = JSON.parse(
  fs.readFileSync(path.join(root, "l10n", "bundle.l10n.es.json"), "utf8"),
) as Record<string, string>;

/** Cadena del fuente dentro de un `vscode.l10n.t(...)` de una sola línea. */
const CALL = /vscode\.l10n\.t\(\s*(["'])((?:\\.|(?!\1)[^\\])*)\1/g;

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    // `src/webview` es contexto de navegador: ahí vscode.l10n no existe.
    if (entry.isDirectory()) {
      if (entry.name !== "webview") {
        sourceFiles(full, out);
      }
    } else if (entry.name.endsWith(".ts")) {
      out.push(full);
    }
  }
  return out;
}

function usedKeys(): Set<string> {
  const keys = new Set<string>();
  for (const file of sourceFiles(path.join(root, "src"))) {
    const text = fs.readFileSync(file, "utf8");
    for (const match of text.matchAll(CALL)) {
      keys.add(match[2]);
    }
  }
  return keys;
}

describe("vscode.l10n", () => {
  test("el fuente tiene mensajes que localizar", () => {
    assert.ok(usedKeys().size > 0, "no aparece ningún vscode.l10n.t en el fuente");
  });

  // La cadena del fuente es la CLAVE del bundle: si falta la traducción, VS Code
  // no falla, avisa en el log y devuelve el inglés — o sea, se pierde en silencio.
  test("cada mensaje del fuente tiene traducción al español", () => {
    for (const key of usedKeys()) {
      assert.ok(key in bundle, `sin traducción: ${JSON.stringify(key)}`);
    }
  });

  test("ninguna clave del bundle sobra sin usarse", () => {
    const used = usedKeys();
    for (const key of Object.keys(bundle)) {
      assert.ok(used.has(key), `clave sobrante en el bundle: ${JSON.stringify(key)}`);
      assert.ok(bundle[key].trim().length > 0, `traducción vacía: ${key}`);
    }
  });

  // Si el fuente acabara en español, los usuarios de inglés verían español:
  // la cadena es literalmente lo que se muestra cuando no hay bundle.
  test("los mensajes del fuente están en inglés, sin acentos ni signos de apertura", () => {
    for (const key of usedKeys()) {
      assert.ok(!/[áéíóúñÁÉÍÓÚÑ¿¡]/.test(key), `el fuente no está en inglés: ${key}`);
    }
  });

  // Marcadores de que el refactor llegó a donde debía: el botón de la sección y
  // el flujo de instalación (P-031) son lo que el usuario ve casi siempre. La
  // pregunta ya vive en un panel de la propia sección (P-044), así que las
  // sentinelas son su texto y sus dos botones, no el viejo diálogo modal.
  test("siguen localizados el botón de lanzado y el flujo de instalación", () => {
    const used = usedKeys();
    for (const sentinel of [
      "Launch OpenCode",
      "OpenCode was not found on your PATH.",
      "Installing OpenCode…",
      "Yes, install",
      "No",
    ]) {
      assert.ok(used.has(sentinel), `desapareció: ${sentinel}`);
      assert.ok(sentinel in bundle, `sin traducción: ${sentinel}`);
    }
  });

  // El webview no puede usar l10n, así que las etiquetas de fase se resuelven en
  // el host: si la extensión dejara de mandar `label`, la sección saldría muda.
  test("las etiquetas de fase se traducen en el host, no en el webview", () => {
    const view = fs.readFileSync(path.join(root, "src", "views", "TuiView.ts"), "utf8");
    assert.ok(/function phaseLabel\(/.test(view), "phaseLabel desapareció de TuiView");
    for (const phase of ["Error:", "Checking OpenCode…", "Installing OpenCode…"]) {
      assert.ok(phase in bundle, `sin traducción de la fase: ${phase}`);
    }

    const client = fs.readFileSync(path.join(root, "src", "webview", "client.ts"), "utf8");
    assert.ok(!/PHASE_LABEL/.test(client), "volvió el mapa de etiquetas hardcodeado en el webview");
    assert.ok(/msg\.label/.test(client), "el webview deja de usar la etiqueta del host");
  });
});
