/**
 * Genera `resources/opencode-icons.woff` a partir del logo oficial.
 *
 * Por qué una fuente y no un SVG: la barra de estado de VS Code solo admite
 * codicons — `StatusBarItem.text` entiende `$(id)` pero no una ruta arbitraria.
 * La única vía oficial para meter un icono propio ahí es `contributes.icons`,
 * y ese punto de contribución pide una FUENTE (woff/ttf) con el glifo.
 *
 * Métricas copiadas de extensiones que VS Code ya dibuja bien (medidas con el
 * propio fichero, no a ojo):
 *   fanaticpythoner.better-todo-tree  unitsPerEm 1000, advanceWidth 1000, PUA EA01
 *   ms-toolsai.datawrangler           unitsPerEm 1024, advanceWidth 1024
 *
 * El trazo sale del favicon del repo oficial (anomalyco/opencode,
 * packages/ui/src/assets/favicon/favicon.svg), recortado al anillo para que en
 * 16px se lea limpio: el bloque interior del favicon es detalle bicolor y en
 * ese tamaño se convierte en barro.
 *
 * Uso:  node scripts/build-icon-font.mjs
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import opentype from "opentype.js";
import ttf2woff from "ttf2woff";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, "..");
const out = path.join(root, "resources", "opencode-icons.woff");

/** viewBox 0 0 512 512, con Y hacia abajo como en SVG. */
const SVG_BOX = 512;
const RING = {
  outer: { x1: 128, y1: 96, x2: 384, y2: 416 },
  inner: { x1: 192, y1: 160, x2: 320, y2: 352 },
};

const UNITS = 1000;
const PADDING = 80;
const CODEPOINT = 0xe001; // área privada: no choca con ningún glifo real

/**
 * Mapea de coordenadas SVG (Y abajo) a unidades de fuente (Y arriba, sobre la
 * línea base). La altura disponible se usa casi entera; el ancho se centra.
 */
const scale = (UNITS - PADDING * 2) / (RING.outer.y2 - RING.outer.y1);
const width = (RING.outer.x2 - RING.outer.x1) * scale;
const xOffset = (UNITS - width) / 2;
const x = (svgX) => xOffset + (svgX - RING.outer.x1) * scale;
const y = (svgY) => PADDING + (RING.outer.y2 - svgY) * scale;

/**
 * Rectángulo como contorno cerrado.
 *
 * TrueType rellena por sentido de giro: el contorno EXTERNO va en sentido
 * horario (visto con Y arriba) y el HUECO en antihorario. Si los dos van igual,
 * el centro se rellena y el anillo sale macizo.
 */
function addRect(p, r, clockwise) {
  const [a, b, c, d] = [
    [x(r.x1), y(r.y2)], // superior izquierda
    [x(r.x2), y(r.y2)], // superior derecha
    [x(r.x2), y(r.y1)], // inferior derecha
    [x(r.x1), y(r.y1)], // inferior izquierda
  ];
  const order = clockwise ? [a, b, c, d] : [a, d, c, b];
  p.moveTo(order[0][0], order[0][1]);
  for (const [px, py] of order.slice(1)) {
    p.lineTo(px, py);
  }
  p.close();
}

const iconPath = new opentype.Path();
addRect(iconPath, RING.outer, true);
addRect(iconPath, RING.inner, false);

const font = new opentype.Font({
  familyName: "OpenCodeIcons",
  styleName: "Regular",
  unitsPerEm: UNITS,
  // Igual que better-todo-tree.woff: no hay descensos, así la línea base no
  // desplaza el icono dentro de la caja de 16px de la barra de estado.
  ascender: UNITS,
  descender: 0,
  glyphs: [
    new opentype.Glyph({ name: ".notdef", unicode: 0, advanceWidth: 0, path: new opentype.Path() }),
    new opentype.Glyph({ name: "opencode", unicode: CODEPOINT, advanceWidth: UNITS, path: iconPath }),
  ],
});

const ttf = Buffer.from(font.toArrayBuffer());
const woff = Buffer.from(ttf2woff(ttf).buffer);

fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, woff);

console.log(`  escrito ${path.relative(root, out)}  (${woff.length} bytes, glifo U+${CODEPOINT.toString(16).toUpperCase()})`);
console.log(`  escala ${scale.toFixed(3)}  ancho ${Math.round(width)}u  xOffset ${Math.round(xOffset)}u`);
