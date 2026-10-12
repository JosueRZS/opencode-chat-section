import Module from "module";
import * as path from "path";

/**
 * Redirige `require("vscode")` al stub.
 *
 * Fuera del extension host ese módulo no existe: Node lanza "Cannot find module
 * 'vscode'" nada más importar cualquier fichero de `src/`. El hook se cuelga de
 * `Module._resolveFilename`, que es el único punto por el que pasan TODOS los
 * `require` — el mismo truco que usan `@vscode/test-electron` y las suites de
 * extensiones habituales.
 *
 * Hay que importarlo ANTES que cualquier módulo de `src/`: en CommonJS los
 * `require` se ejecutan en orden de aparición, así que un `import "./register"`
 * en la primera línea basta.
 */
type ResolveFn = (request: string, ...rest: unknown[]) => string;

const stubPath = path.join(__dirname, "support", "vscode.js");
const original: ResolveFn = (Module as unknown as { _resolveFilename: ResolveFn })._resolveFilename;

(Module as unknown as { _resolveFilename: ResolveFn })._resolveFilename = (
  request: string,
  ...rest: unknown[]
): string => (request === "vscode" ? stubPath : original(request, ...rest));
