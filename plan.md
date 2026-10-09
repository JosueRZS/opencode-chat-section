# 🛠️ OPENCHAMBER: Plan de Desarrollo y Arquitectura (v5 — extensión propia, objetivo OpenCode v2)

**Contexto para el Agente:**
Tu objetivo es construir una extensión **propia** para Visual Studio Code llamada `opencode-vscode-chat`.

**Decisión ya tomada:** extensión propia, **no PR** a `anomalyco/opencode`. Motivo: dos de los cuatro cambios pedidos no son PR-ables (colocación en la barra secundaria no tiene API; el ciclo efímero contradice el diseño de reutilización deliberada de la oficial).

**Diseño base (léelo antes que nada):** la extensión **no implementa un chat**. Crea **una única terminal propia de VS Code** corriendo el TUI oficial de OpenCode; OpenCode se encarga de todo (agente, herramientas, permisos, diffs, sesiones, persistencia de conversación). Nuestra extensión aporta solo cuatro cosas, que **la extensión oficial `sst-dev.opencode` no tiene** (verificado leyendo `sdks/vscode/src/extension.ts`, un fichero de ~130 líneas):

1. **Posición** — terminal en la **Secondary Side Bar**, como pestaña junto al chat de GitHub Copilot.
2. **Lógica** — comando `toggle` + keybindings para **alternar** entre OpenCode y el chat de VS Code.
3. **Ciclo de vida efímero** — `Launch OpenCode Chat` crea la pestaña; **al salir (`/exit` o fin de proceso) se elimina**. No la persistimos: OpenCode persiste sus sesiones.
4. **Triggers de instalación** — si falta `opencode`, ofrecer instalarlo oficialmente; si el usuario dice que no, **no se abre nada**.

---

## 0. 🎯 Alcance, Referencias y Motivación

### 0.1 Por qué NO usar los puentes BYOK

`mfenderov/opencode-copilot-sync` y `ltmoerdani/opencode-copilot-chat` registran modelos de OpenCode **dentro del chat nativo de Copilot**. El modelo es el mismo, pero **el *harness* no**: Copilot aporta su bucle agente, sus prompts de sistema, sus herramientas, sus permisos y su contexto. No obtienes el agente de OpenCode (agentes `build`/`plan`, subagentes, `AGENTS.md`, MCP, sesiones, share). **Esa es la pérdida de calidad**: no es el modelo, es el motor que lo ejecuta.

### 0.2 Qué replicamos, qué extiendenos, qué descartamos

| Referencia | Qué es | Tratamiento |
| --- | --- | --- |
| **Extensión oficial** — Marketplace `sst-dev.opencode` (`publisher: sst-dev`, `name: opencode`); fuente `anomalyco/opencode/sdks/vscode`; docs `opencode.ai/docs/ide/` | Un único `extension.ts` de ~130 líneas: crea terminal con `ViewColumn.Beside`, arranca `opencode --port <p>` y manda contexto por `POST /tui/append-prompt`. | **Mecanismo DESACTUALIZADO en v2** (`--port` ya no existe; ver P-005/P-007). Conservamos su **patrón** (terminal propia + `sendText(x, false)` como fallback) y su `getActiveFile()`. **No** su disposición (editor partido) ni su reutilización de pestaña. |
| `openchamber/openchamber` | GUI completa; patrón "interfaz del agente junto al código, en pestaña arrastrable". | Solo el **patrón de colocación**. |
| `mfenderov/opencode-copilot-sync`, `ltmoerdani/opencode-copilot-chat` | Puentes BYOK hacia Copilot. | ❌ **Fuera de alcance** (§0.1). |

### 0.3 Nuestra divergencia con la oficial (por qué existe la extensión)

| Comportamiento | `sst-dev.opencode` | **Nosotros** |
| --- | --- | --- |
| Dónde abre la terminal | `location: { viewColumn: ViewColumn.Beside }` → **área de editor partido** | Vista Terminal (por defecto en panel) → **arrastrable a la Secondary Side Bar** junto a Chat |
| Pestaña existente | `terminals.find(t => t.name === "opencode") → .show()` → **la reutiliza** | **Efímera**: se dispose al salir; `newSession` = dispose + crear |
| Alternancia con Copilot | ❌ No existe | ✅ `opencodeChat.toggle` |
| Trigger de instalación | ❌ No existe | ✅ Guard `ensureOpenCode()` con modal Sí/No |
| Contexto (`@file#L10-20`) | ✅ Sí (`getActiveFile()`) | ✅ Mismo formato, con sanitización añadida |
| Canal de contexto | ✅ `--port` + `POST /tui/append-prompt` (**roto en v2**) | ✅ `sendText(texto, false)` — **único canal válido en v2** (§1.1) |
| Ciclo de vida de la pestaña | ❌ Reutiliza la pestaña indefinidamente | ✅ Efímera: se cierra al salir de OpenCode (§7) |

### 0.4 Licencia y marca (obligatorio antes de publicar)

- OpenCode y OpenChamber son **MIT**. Copiamos mecanismo de un fichero de ~130 líneas → **conservar atribución en `README.md` y en un comentario del fichero fuente.**
- OpenCode pide a proyectos con "opencode" en el nombre una nota de **no afiliación** → `README.md` + descripción del Marketplace.
- No usar `opencode` como `name`/publisher (colisiona con `sst-dev.opencode`).

---

## 1. 🏗️ Arquitectura (v5 — sin llamadas HTTP)

```text
┌──────────────── Secondary Side Bar ────────────────┐
│  [ Chat de GitHub Copilot ]  [ Terminal: opencode ] │  ← pestañas juntas
└────────────────────────────────────────────────────┘
                     ▲                    ▲
        solo movemos el foco aquí ←→ aquí │
                     │                    │
   Extension Host (Node puro) ─────────────┴──  Webview ✗  (NO existe)
   · createTerminal() efímera               · Sin UI propia
   · comandos + keybindings                 · El TUI de OpenCode ES la UI
   · canal sendText(texto, false) — sin HTTP
   · detección de salida → dispose de la pestaña
   · guard de instalación
```

### 1.1 El canal (D3 — **reescrito en v5** tras el spike de Fase 0)

> ⚠️ **El mecanismo v4 estaba roto.** Contra OpenCode **v2.0.26** (ver `PROBLEMAS.md` P-005/P-007):
> `opencode --port N` → `Unrecognized flag: --port` · `GET /app` → **no existe** · `POST /tui/append-prompt` → **404**.
> La doc `opencode.ai/docs/server/` que describía esos endpoints **es de v1**.
> **v5 elimina el canal HTTP por completo** → sin puerto, sin env, sin auth, sin `waitFor`.

```ts
// 1. Terminal en la vista Terminal (arrastrable a la Secondary Side Bar)
const term = vscode.window.createTerminal({
  name: "opencode",
  location: vscode.TerminalLocation.Panel,   // ← NO ViewColumn.Beside
  cwd,
});
term.show();

// 2. Lanzar. Encadenamos `exit` para que la pestaña muera con el TUI (D1).
//    `;` vale en PowerShell/bash/zsh/fish/Git Bash; `&` solo hace falta en cmd (P-010).
const sep = isCmdShell() ? "&" : ";";
term.sendText(`opencode ${sep} exit`);

// 3. Inyectar contexto — ÚNICO canal en v2 (no hay endpoint equivalente):
//    teclea en el compositor del TUI sin enviar (el usuario revisa y pulsa Enter).
term.sendText(texto, /* addNewLine */ false);
```

**Por qué `sendText(x, false)` y no la API:** `POST /api/session/{id}/prompt` existe en v2, pero **envía** el mensaje y **dispara el agente** — no rellena el compositor para revisión. No es equivalente al antiguo `append-prompt`. Reservado como opción futura de "autoenvío" (requeriría Basic Auth: ver §9).

**Bonus de robustez:** al no depender de `--port` ni de endpoints, **el mismo mecanismo funciona en OpenCode v1 y v2**.

**Si el usuario prefiere no encadenar `exit`:** red de seguridad `onDidEndTerminalShellExecution` (§7.3).

### 1.2 Descartado explícitamente

- ✗ Webview con chat propio (React/Vite/Tailwind) — OpenCode ya lo hace.
- ✗ `@opencode-ai/sdk` — innecesario: **ya no hay canal HTTP** (§1.1). Basta `sendText`.
- ✗ **Cualquier llamada al servidor v2** (`/api/*`, `/app`, `/tui/*`) — descartado por el spike (P-005…P-009).
- ✗ Parseo de la salida del TUI (`strip-ansi`, JSON, buscar `/exit` en stdout) — **nunca leer el stdout**.
- ✗ Fork o duplicado de la extensión oficial.

---

## 2. 📂 Estructura de Directorios Deseada

```text
opencode-vscode-chat/
├── package.json                 # Manifest: commands, keybindings, configuration
├── tsconfig.json
├── .vscodeignore
├── .vscode/
│   ├── launch.json              # F5 → Extension Development Host
│   └── tasks.json               # watch de tsc + esbuild
├── images/
│   ├── icon.svg
│   └── setup-guide.png          # Captura del arrastre a la barra secundaria
└── src/
    ├── extension.ts             # activate/deactivate + registro de comandos
    ├── guards/
    │   └── ensureOpenCode.ts    # ★ Guard único: detecta / instala / aprueba (§8)
    ├── terminal/
    │   ├── OpenCodeTerminal.ts  # Crear / encontrar / enfocar la terminal efímera (§1.1)
    │   └── lifecycle.ts         # ★ detección de salida del TUI → dispose() (§7)
    ├── commands/
    │   ├── launch.ts            # Launch OpenCode Chat (punto de entrada principal)
    │   ├── toggleChats.ts       # Alternancia OpenCode ⇄ Copilot Chat
    │   ├── focus.ts             # focus / focusVscodeChat
    │   └── context.ts           # sendSelection, insertFileRef, newSession
    └── utils/
        ├── detection.ts         # Resolución de `opencode` en PATH (win/darwin/linux)
        ├── shell.ts             # isCmdShell() → separador `;` vs `&` (P-010)
        ├── installer.ts         # ★ Instalador oficial por plataforma (§8)
        └── setup.ts             # Guía de colocación en la barra secundaria
```

---

## 3. 📜 Manifest de VS Code (`package.json`)

### 3.1 `contributes.commands`

```jsonc
"commands": [
  { "command": "opencodeChat.launch",         "title": "OpenCode: Launch OpenCode Chat", "icon": "$(comment-discussion)" },
  { "command": "opencodeChat.toggle",         "title": "OpenCode: Toggle Chat View",     "icon": "$(replace)" },
  { "command": "opencodeChat.focus",          "title": "OpenCode: Focus Terminal" },
  { "command": "opencodeChat.focusVscodeChat","title": "OpenCode: Focus VS Code Chat" },
  { "command": "opencodeChat.newSession",     "title": "OpenCode: New Session" },
  { "command": "opencodeChat.sendSelection",  "title": "OpenCode: Send Selection to Agent" },
  { "command": "opencodeChat.insertFileRef",  "title": "OpenCode: Insert File Reference" },
  { "command": "opencodeChat.setupGuide",     "title": "OpenCode: Show Side Bar Setup Guide" }
]
```

> **Todos pasan por `ensureOpenCode()` (§8) antes de hacer nada.**

### 3.2 `contributes.keybindings` (requisito explícito)

**D2 — resuelto con el default seguro:** sin colisiones con la oficial (`ctrl+escape`, `ctrl+shift+escape`, `ctrl+alt+K`), de modo que funcionan **instalando solo la nuestra o ambas**.

```jsonc
"keybindings": [
  { "command": "opencodeChat.launch",
    "key": "ctrl+alt+o", "mac": "cmd+alt+o", "linux": "ctrl+alt+o" },
  { "command": "opencodeChat.toggle",
    "key": "ctrl+alt+shift+o", "mac": "cmd+alt+shift+o", "linux": "ctrl+alt+shift+o" },
  { "command": "opencodeChat.newSession",
    "key": "ctrl+alt+n", "mac": "cmd+alt+n", "linux": "ctrl+alt+n" },
  { "command": "opencodeChat.sendSelection",
    "key": "ctrl+alt+enter", "mac": "cmd+alt+enter", "linux": "ctrl+alt+enter" },
  { "command": "opencodeChat.insertFileRef",
    "key": "ctrl+alt+k", "mac": "cmd+alt+k", "linux": "ctrl+alt+k" }
]
```

El README llevará **también** el bloque "compatibilidad con la extensión oficial" (mapear `ctrl+escape` → `launch`, etc.) listo para pegar en `keybindings.json`.

> Cualquier keybinding aportado es sobrescribible por el usuario. **No hay que construir una UI de configuración propia.**

### 3.3 `contributes.configuration`

```jsonc
"configuration": {
  "title": "OpenCode Chat",
  "properties": {
    "opencodeChat.cliPath":        { "type": "string", "default": "opencode",
      "scope": "machine",
      "description": "Ruta a la binaria de OpenCode. Vacío = buscar en PATH." },
    "opencodeChat.terminalCwd":    { "type": "string", "default": "${workspaceFolder}" },
    "opencodeChat.focusOnLaunch":  { "type": "boolean", "default": true },
    "opencodeChat.disposeOnExit":  { "type": "boolean", "default": true,
      "description": "Eliminar la pestaña de terminal cuando OpenCode termina." },
    "opencodeChat.chainExit":      { "type": "boolean", "default": true,
      "description": "Encadenar `exit` al lanzar, para que la pestaña se cierre al salir de OpenCode (§7.3)." },
    "opencodeChat.autoPromptInstall": { "type": "boolean", "default": true },
    "opencodeChat.installMethod":  { "type": "string", "default": "auto",
      "enum": ["auto", "npm", "script"] }
  }
}
```

### 3.4 `contributes.menus`

```jsonc
"menus": {
  "editor/context":   [ { "command": "opencodeChat.sendSelection", "group": "opencode@1" } ],
  "explorer/context": [ { "command": "opencodeChat.insertFileRef", "group": "opencode@1" } ],
  "editor/title":     [ { "command": "opencodeChat.launch", "group": "navigation" } ]
}
```

> **No se contribuye ningún `viewsContainers`.** No hay vista propia: la UI es la terminal. Elimina de raíz el problema de colocación de vistas.

---

## 4. 🪟 Posicionamiento en la barra secundaria

**Verificado:** sí se puede. VS Code admite mover la vista **Terminal** a la barra lateral secundaria, donde los terminales conviven como pestañas.

- [Custom Layout — VS Code](https://code.visualstudio.com/docs/configure/custom-layout): *"At any time, you can drag and drop views and panels into the Primary or Secondary Side Bar."*
- [microsoft/vscode#318095](https://github.com/microsoft/vscode/issues/318095): *"Moving the Terminal view to the Primary or Secondary Side Bar **relocates** it"*. Su caso de uso es literalmente el nuestro: *"Secondary Side Bar (right): an AI agent's terminal… pinned where chat-style UIs naturally belong"*.
- Empírico: extensión [Secondary Sidebar Terminal](https://marketplace.visualstudio.com/items?itemName=ytyng.secondary-terminal), guías de arrastre.

> **Nota clave:** por eso usamos `TerminalLocation.Panel` (vista Terminal) y **no** `ViewColumn.Beside` como la oficial. Lo que se arrastra a la barra secundaria es la *vista Terminal*; una pestaña de editor no se puede arrastrar ahí.

### 4.1 D1 — una sola terminal efímera

**Una única pestaña**, del mismo estilo que la shell por defecto del panel inferior (`Ctrl+J`). El usuario **la acepta como su única shell**, por lo que el coste histórico de reubicar todas las terminales queda anulado: no hay otras shells que perder.

Alternativas documentadas por si cambia el layout:

| # | Layout | Consecuencia |
| --- | --- | --- |
| **A (elegido)** | Vista Terminal arrastrada a la Secondary Side Bar. | Nuestra pestaña efímera queda junto a Chat; es también la única shell del usuario. |
| B | Panel a la derecha (`workbench.panel.defaultLocation: "right"`). | Terminal a la derecha sin tocar la barra secundaria; Copilot queda fuera de la columna. |
| C | Terminal como pestaña de editor (`terminal.integrated.defaultLocation: "editor"`). | Convive con el código, **no** junto a Copilot. |

### 4.2 `opencodeChat.setupGuide`

No existe API pública ni punto de contribución para colocar una terminal en la barra secundaria (`terminal.integrated.defaultLocation` solo admite `"view" | "editor"`; `viewsContainers` solo `activitybar | panel`). La colocación es **manual, una sola vez, y persistente**.

La guía (`showInformationMessage` con acción + `QuickPick`) debe:
1. Ejecutar `workbench.action.toggleAuxiliaryBar` para que la barra sea visible.
2. Ejecutar `workbench.action.openView` con la vista `terminal` para enfocarla.
3. Mostrar instrucciones de arrastre con `images/setup-guide.png` (también en el README).
4. Ofrecer las alternativas B y C de §4.1.
5. Registrar en `globalState` que ya se mostró.

---

## 5. ⌨️ Lógica de alternancia con el chat de VS Code

### 5.1 Comandos

| Comando | Implementación |
| --- | --- |
| `opencodeChat.focus` | `terminal.show(false)` sobre la terminal dedicada. Fallback: `workbench.action.terminal.focus`. |
| `opencodeChat.focusVscodeChat` | `executeCommand('workbench.action.chat.open')`. Fallback: `try/catch` → `workbench.action.toggleAuxiliaryBar` + aviso. |
| `opencodeChat.toggle` | Algoritmo de §5.2. |

> ⚠️ **`workbench.action.chat.open` no es API pública estable.** Mitigación: `vscode.commands.getCommands(true)` antes de invocar, `try/catch`, degradación con mensaje. Anotar la versión de VS Code probada en el README.

### 5.2 Algoritmo de `toggle`

Señal más fiable y barata: **nuestra propia terminal**.

```ts
const our = estado.terminal;
if (!our || !isAlive(our)) { await launch(); return; }   // efímera → si no existe, lanzar
if (vscode.window.activeTerminal === our) await focusVscodeChat();
else                                      await focus();
```

Refuerzo si `activeTerminal` no refleja bien el cambio de foco hacia el chat:

```ts
context.subscriptions.push(
  vscode.window.onDidChangeActiveTerminal(t => { if (t === our) estado.last = "opencode"; }),
  vscode.window.onDidChangeTextEditorFocus(() => { estado.last = "editor"; }),
);
// toggle: estado.last === "opencode" ? focusVscodeChat() : focus()
```

**No** hace falta `setContext` ni adivinar dónde está Copilot: basta con saber cuándo *nosotros* tenemos el foco.

### 5.3 Keybindings alternos (opcional)

```jsonc
{ "command": "opencodeChat.focus",          "key": "ctrl+alt+o", "when": "!opencodeChat.terminalFocused" },
{ "command": "opencodeChat.focusVscodeChat","key": "ctrl+alt+o", "when": "opencodeChat.terminalFocused" }
```

---

## 6. 🧠 Contexto del editor (paridad con la extensión oficial)

**Formato real, extraído de `getActiveFile()` de la oficial** (v3 lo tenía mal):

| Situación | Texto producido |
| --- | --- |
| Fichero activo, sin selección | `@src/ruta/fichero.ts` |
| Selección de una línea (`L10`) | `@src/ruta/fichero.ts#L10` |
| Selección multilínea (`L10`→`L20`) | `@src/ruta/fichero.ts#L10-20` |

⚠️ **No hay segunda `L`**: es `#L10-20`, **no** `#L10-L20`. Rutas relativas al workspace (`vscode.workspace.asRelativePath`).

**Envío — canal único en v2 (§1.1):**
- `terminal.sendText(texto, **false**)` — **sin Enter**, solo teclear en el prompt, para que el usuario revise antes de enviar.
- **No existe alternativa HTTP** en v2: `POST /api/session/{id}/prompt` *envía* el mensaje y dispara el agente; no rellena el compositor.

**Sanitización obligatoria para el fallback `sendText`** (T7 de §13):
- Reemplazar saltos de línea por espacios → si no, cada línea se envía como un Enter.
- Recortar (p. ej. 2000 caracteres).
- Si el TUI tiene un diálogo/selector abierto, abortar el envío.

---

## 7. 🔄 Ciclo de Vida de la Terminal (efímera)

**Requisito de D1:** la pestaña **no se persiste**. Se crea al lanzar y **se elimina al terminar**. OpenCode persiste sus propias sesiones; nosotros solo gestionamos la pestaña.

### 7.1 Máquina de estados

```text
  idle ──launch──▶ running ──TUI sale / pestaña se cierra──▶ idle
   ▲                     │
   └───── dispose() ◀────┘
```

### 7.2 Creación

Ver §1.1. Puntos críticos:
- `location: TerminalLocation.Panel` → la pestaña vive en la vista Terminal (arrastrable a la barra secundaria).
- **Sin puerto, sin `env`, sin `waitFor`** — v2 no lo permite (P-005/P-007).
- Lanzamiento por `sendText('opencode' + sep + ' exit')` **dentro de un shell**, nunca `shellPath` (P-001).
- `sep`: `&` si el perfil de terminal es `cmd.exe`, `;` en cualquier otro caso (P-010).
- Estado en variable del módulo (`Map<Terminal, Estado>`), no en el env.
- **`ensureOpenCode()` corre ANTES de crear la terminal** → si falta el CLI no se crea pestaña que se cerraría sola al instante.

### 7.3 Detección de terminación → borrado de la pestaña

OpenCode corre como **hijo del shell**: al escribir `/exit` solo muere el hijo y **el shell sobrevive** con su prompt → la pestaña se quedaría abierta.

> ❌ **El health-poll de v4 (3 fallos de `GET /app`) es inválido en v2.**
> En v1 el TUI *era* el servidor; en v2 el servidor es un **background service independiente** (`/api/info` devuelve el `pid` del servicio, no el del TUI). Matar el TUI **no cambió** ni `/api/info` ni `/api/session/active` → el sondeo **nunca** dispararía (P-009, verificado empíricamente). Además `/app` no existe (P-003).

Tres señales, en orden de prioridad — **ninguna lee el stdout**:

**① `exit` encadenado (primaria).** `sendText('opencode ; exit')` → al morir el TUI el shell ejecuta `exit` → el proceso de la terminal termina → **VS Code cierra la pestaña él solo**. Funciona en cualquier shell y no necesita API adicional.

**② Shell integration (red de seguridad).** Si `chainExit` está desactivado o el encadenado no cuadra con el shell:

```ts
vscode.window.onDidEndTerminalShellExecution(e => {
  if (e.terminal !== estado.terminal) return;
  if (/opencode/.test(e.execution.commandLine.value)) e.terminal.dispose();
});
```

- Cubre **PowerShell / pwsh / bash / zsh / fish / Git Bash**. **`cmd.exe` NO tiene shell integration en Windows** (solo `pwsh` y Git Bash) — de ahí que ① sea la primaria (P-010). Validar en Fase 0 → T9.

**③ `onDidCloseTerminal` (limpieza, idempotente).** El usuario cierra la pestaña a mano, o ① ya la cerró → `estado.terminal = undefined`, `estado = "idle"`.

Las tres son idempotentes y se desactivan en cuanto dispare cualquiera.

### 7.4 Relanzar y reutilizar

- `launch()` con terminal viva → `show()` (una sola pestaña, §4.1).
- Terminal muerta → `estado = undefined` en `onDidCloseTerminal`; el siguiente `launch()` crea una nueva.
- `newSession` → `dispose()` + crear de nuevo. OpenCode recupera sus sesiones por su propia persistencia.

### 7.5 Desactivación

`deactivate` → `terminal.dispose()` si la creamos nosotros. No matar terminales ajenas.

---

## 8. 🚨 Flujo de Detección e Instalación de OpenCode (triggers)

**Transversal: todos los comandos lo atraviesan.** Una sola función guard para que el comportamiento sea idéntico en `launch`, `toggle`, `sendSelection`, etc.

### 8.1 `ensureOpenCode(): Promise<boolean>`

```text
   cualquier comando
        ──────────▶  ensureOpenCode()
                            │
                  ¿`opencode` resuelto en PATH?
                     │                  │
                    SÍ                  NO
                     │                  ▼
                     │         ¿autoPromptInstall?
                     │            │            │
                     │           NO            SÍ
                     │            │            ▼
                     │            │    MODAL (modal: true, bloqueante)
                     │            │    "Falta instalar OpenCode"
                     │            │    [Sí, instalar]  [No]
                     │            │       │             │
                     │            │       ▼             ▼
                     │            │   instalar      CERRAR MODAL
                     │            │   (§8.3)        y NO abrir
                     │            │       │          el panel
                     │            │       ▼             │
                     │            │   ¿éxito?           │
                     │            │    SÍ → seguir      │
                     │            │    NO → error       │
                     │            ▼       ▼             ▼
                     ◀──────── false ◀─── true/false ──▶ false
                            │
                            ▼
                      crear terminal (§7)
```

**Reglas invariantes:**
- **`No` ⇒ `false` ⇒ no se abre la terminal ni ningún panel.** Solo se cierra el modal. Sin excepciones.
- **`Sí` ⇒ instalar la última versión oficial** ⇒ si tiene éxito, re-detectar y continuar abriendo.
- Nunca instalar sin consentimiento explícito.
- Cada comando: `if (!(await ensureOpenCode())) return;`.

### 8.2 Detección

```ts
// Resolución por el PATH del shell, con shell:true (P-001: en Windows `where.exe`
// devuelve 2 entradas y la primera NO es ejecutable por CreateProcess).
execFile("opencode", ["--version"], { shell: process.platform === "win32" })
//   → "opencode v2.0.26"  ⇒ instalado (y además sabemos si es v1 o v2)
```

- Resolver `cliPath` primero; si está vacío, PATH. Cache en memoria, invalidada tras instalar.
- **T5 resuelto (P-001):** jamás `shellPath: "opencode"`; siempre dentro del shell vía `sendText`.
- Si `--version` falla ⇒ no instalado ⇒ §8.1.

### 8.3 Instalación oficial (última versión)

> ⚠️ **Corregido en Fase 0 (P-011):** `npm i -g opencode-ai@latest` instala **v1.18.35**, no v2. La doc v2 declara además *«Windows package managers are not supported»* → **`scoop` y `choco` fuera**.

Comandos **oficiales de `https://opencode.ai/v2/docs`**, ofrecidos en `QuickPick` si `installMethod === "auto"`:

| Plataforma | Método | Comando |
| --- | --- | --- |
| **Windows / macOS / Linux** | **npm (primario)** | `npm install -g @opencode/cli` |
| macOS / Linux | script | `curl -fsSL https://opencode.ai/v2/install \| bash` |
| macOS / Linux | brew | `brew install anomalyco/tap/opencode-v2` |
| Windows | binario | `opencode-windows-x64.zip` desde `opencode.ai/v2/docs` |

- **En Windows, npm es el único método sin dependencias extra**: el script oficial es **solo bash** (`https://opencode.ai/install.ps1` → **404**) y los package managers de Windows no están soportados en v2.

Ejecución:
1. `window.withProgress({ location: Notification })` mientras corre.
2. Ejecutar en una **terminal temporal** (no en la dedicada) o `child_process.exec` con salida a un OutputChannel propio.
3. **Éxito** → re-detectar. Si el PATH de la sesión de VS Code quedó desactualizado (frecuente en Windows) → ofrecer `workbench.action.reloadWindow` y marcarlo en `globalState`.
4. **Fallo** → `showErrorMessage` con acción *"Ver documentación"* → `https://opencode.ai/v2/docs`. Devolver `false`.
5. Método no disponible en la máquina (p. ej. sin `npm`) → `showErrorMessage` con *"Probar otro método"* → volver al `QuickPick`.

### 8.4 Persistencia de estado

- `globalState['opencodeChat.installDeclined']` — dijo "No": **no volver a preguntar** en cada comando; solo mediante `setupGuide` o comando explícito.
- `globalState['opencodeChat.needsReload']` — tras instalar, sabe que hay que recargar.

---

## 9. 🔒 Seguridad

- **No leer ni loguear el stdout del TUI** (prompts, ficheros, claves). Diagnóstico solo en OutputChannel propio, desactivado por defecto.
- Instalación solo tras consentimiento explícito y **solo comandos oficiales** de `opencode.ai` (§8.3). Nada de binarios de terceros.
- Ejecutar instaladores con `shell: false` donde sea posible; validar el binario resuelto.
- **Sin canal HTTP** en v5 (§1.1) → no hay nada que autenticar ni qué acotar a localhost.
  - Si en el futuro se añade (`POST /api/session/{id}/prompt`): hablar **solo con `127.0.0.1`** (`opencode service status` → URL; `~/.config/opencode/service.json` → password), con Basic Auth `opencode:<pass>`. **Nunca** ampliar a `0.0.0.0`, **nunca** loguear el password.
- `cliPath` con `scope: "machine"` (no se sincroniza entre equipos).
- Respetar `vscode.workspace.isTrusted`: sin confianza → no auto-instalar ni auto-ejecutar; solo mostrar terminal y guía.

---

## 10. 🗓️ Fases de Ejecución

Cada fase se confirma antes de pasar a la siguiente.

- **Fase 0 — Spike.** ✅ **Hecho (sin VS Code):** contrato de endpoints v2 (P-005…P-009), separadores por shell (P-010), instalador oficial (P-011), datos de entorno §13.3. ⚪ **Pendiente de F5:** T2, T3, T4, T7, T9, T10.
- **Fase 1 — Manifest + esqueleto.** `package.json` (§3), `extension.ts`, `OpenCodeTerminal`.
- **Fase 2 — Ciclo de vida efímero.** `lifecycle.ts`: `exit` encadenado + shell integration + `onDidCloseTerminal` → `dispose()`, reutilización (§7).
- **Fase 3 — Guard de instalación.** `ensureOpenCode()` + `installer.ts` con los flujos Sí/No de §8.
- **Fase 4 — Foco y alternancia.** `focus`, `toggle`, con degradación de `workbench.action.chat.open` (§5).
- **Fase 5 — Contexto del editor.** `sendSelection`, `insertFileRef`, formato `#L10-20`, sanitización (§6).
- **Fase 6 — Colocación y onboarding.** `setupGuide` + README con capturas y atribución MIT (§4, §0.4).
- **Fase 7 — Pruebas y empaquetado (§11).**
- **Fase 8 — Publicación.** README con nota de no afiliación, `.vsix`, Marketplace/Open VSX.

---

## 11. 🧪 Pruebas, Empaquetado y Publicación

- **Unitarias:** algoritmo de `toggle`, sanitización para `sendText`, generación de `@relpath` / `#L10` / `#L10-20` (casos borde: selección vacía, multilínea, fichero fuera del workspace), resolución de CLI en PATH (win/darwin/linux), **máquina de estados del guard (Sí/No/éxito/fallo)**, **selección de separador `;`/`&` según el perfil de terminal** (§7.2).
- **Integración** (`@vscode/test-electron`): creación y **dispose al salir** de la terminal, registro de comandos y keybindings, degradación de `workbench.action.chat.open`.
- **E2E manual:** F5 → Extension Development Host → Fase 0 completa + flujo de instalación con `cliPath` apuntando a un binario inexistente.
- **Build:** solo `esbuild`. Sin bundler de front-end, **sin dependencias npm de runtime**.
- **Empaquetado:** `vsce package` → `.vsix`; `.vscodeignore` excluye `.vscode`, `src`, tests y node_modules de desarrollo.
- **CI:** `lint` → `check-types` → `test` → `package` en Windows/macOS/Linux.

---

## 12. ✅ Viabilidad y Riesgos

### Veredicto: **Muy viable — alcance pequeño y bien delimitado**

Sin webview, sin SDK, sin IPC, sin streaming. TypeScript puro sobre la API de VS Code, reutilizando un mecanismo MIT de ~130 líneas que ya funciona.

| # | Riesgo | Severidad | Mitigación |
| --- | --- | --- | --- |
| **R1** | Colocación en la barra secundaria **manual, una sola vez** (no hay API). | **Media** | `setupGuide` + README con capturas (§4.2). VS Code persiste la posición. |
| **R2** | **OpenCode es hijo del shell**: al hacer `/exit` la pestaña **no muere sola**. Y en v2 el background service es independiente → **imposible detectarlo por HTTP** (P-009). | **Media** | `exit` encadenado (primaria) + shell integration (red de seguridad) + `onDidCloseTerminal` (§7.3). Validar T9/T10 en F5. |
| **R3** | `workbench.action.chat.open` no es API estable → el `toggle` puede romperse. | **Media** | `getCommands(true)` + `try/catch` + fallback (§5.1). Detectar dónde estamos no depende de esa API. |
| **R4** | **Solapamiento con `sst-dev.opencode`** (D2): hace lo mismo salvo posición, ciclo de vida, toggle e instalación. | **Media** | Diferenciación explícita en §0.3. Keybindings sin colisión → puede convivir o sustituir. |
| **R5** | `sendText` contra un TUI en modo raw/alternate-screen: saltos de línea, multilínea, diálogos abiertos. **En v2 es el ÚNICO canal** (P-007) → toda la funcionalidad depende de él. | **Alta** | Sanitización obligatoria (§6) + validar T7 en F5 **antes** de construir el resto. |
| **R6** | **Instalación frágil en Windows**: PATH desactualizado, `.cmd` vs `.exe`, falta de `npm` (scoop/choco **no sirven en v2**, P-011). | **Media** | §8.3: npm como primario + binario como alternativa; re-detección + `reloadWindow`. |
| **R7** | Separador de shell equivocado (`;` en `cmd.exe`) → OpenCode **ni siquiera arranca**. | **Baja** | Solo `cmd` rechaza `;`; leer el perfil de terminal y usar `&` (P-010). Red de seguridad: shell integration (§7.3). |
| **R7b** | ~~Colisión de puerto (la oficial usa aleatorios 16384–65535)~~ | — | **Obsoleto en v5**: no hay puerto (P-005). |
| **R8** | Usuario dice "No" y el modal se repite en cada comando. | **Baja** | `globalState['installDeclined']` (§8.4). |
| **R9** | Cambios de OpenCode entre versiones (v1→v2 ya rompió los endpoints; v3 podría cambiar el TUI). | **Media** | v5 **no depende de ningún endpoint** → insensible a esa clase de cambios. Fijar versión mínima probada en README; encapsular lanzamiento en `utils/shell.ts`. **Queda por verificar** que `@fichero#L10-20` sigue parseándose en el TUI v2 (T7). |
| **R10** | Fuga de contexto: leer/loguear el stdout del TUI. | **Baja** | §9: prohibido por diseño. |
| **R11** | Nombre/marca, licencia y atribución al publicar. | **Baja** | §0.4. |

### Esfuerzo estimado (MVP = Fases 0–6)

| Fase | Estimación |
| --- | --- |
| Fase 0 (spike) | 0.5 día |
| Fases 1–3 (esqueleto, ciclo de vida, guard de instalación) | 1.5 días |
| Fases 4–6 (toggle, contexto, colocación) | 1.5 días |
| Fases 7–8 (pruebas, publicación) | 1 día |
| **Total** | **≈ 4.5 días** |

### Fuera de alcance (confirmado)

Webview con chat propio, React/Vite/Tailwind, IPC, streaming SSE, `@opencode-ai/sdk`, tarjetas de permisos/diffs, fork de la extensión oficial, PR a `anomalyco/opencode`, relay/privado, multi-run, Session Goals, schedule, Preview, integración GitHub, móvil/web.

---

## 13. ❓ Pendientes: decisiones e incógnitas abiertas

### 13.1 Decisiones

| # | Estado | Detalle |
| --- | --- | --- |
| **D1** | ✅ Cerrada | Una única pestaña/terminal, tipo shell por defecto. **Efímera**: se crea al lanzar, se elimina al salir. OpenCode persiste sus sesiones; nosotros no persistimos la pestaña. El usuario la acepta como su única shell. |
| **D2** | ✅ **Cerrada (default seguro)** | Keybindings **sin colisión** con la oficial → funciona instalando solo la nuestra o ambas. El README documenta el bloque alternativo por si el usuario quiere adoptar `ctrl+escape` / `ctrl+shift+escape` / `ctrl+alt+K`. |
| **D3** | ✅ **Reabierta y cerrada en v5 (Fase 0)** | v4 seguía el mecanismo de la extensión oficial (`--port` + poll `/app` + `POST /tui/append-prompt`), pero **en OpenCode v2.0.26 eso no existe**: `--port` → flag desconocido (P-005), `/app` → ausente del spec (P-003), `/tui/append-prompt` → 404 (P-007). **v5: `sendText('opencode' + sep + ' exit')` para lanzar y `sendText(texto, false)` para inyectar — sin ninguna llamada HTTP** (P-012). |
| **D4** | ✅ **Corregida en v5** | v4 decía "sin `OPENCODE_SERVER_PASSWORD`" — **falso en v2**: *todos* los servidores exigen Basic Auth (`opencode` + password de `~/.config/opencode/service.json`, o el que imprime `serve`) (P-006). **Pero no aplica**: v5 no hace ninguna llamada HTTP. Queda documentado por si se reintroduce el canal. |
| **D5** | ✅ Cerrada | Alcance **completo**: `launch` + `toggle` + `setupGuide` + `newSession` + `sendSelection` + `insertFileRef`. |
| **D6** | ✅ Cerrada | **Extensión propia**, no PR. Los 4 puntos se implementan sin negociación de diseño ni cola de revisión. |

### 13.2 Incógnitas técnicas — Fase 0

| # | Incógnita | Estado | Detalle |
| --- | --- | --- | --- |
| **T1** | ¿Tras `/exit` el shell sobrevive y se detecta la salida? | 🟢 **Cerrada** | El shell sobrevive (confirmado). Pero **el health-poll NO puede detectarlo** en v2: el servicio es un proceso independiente (P-009). Solución: `exit` encadenado + shell integration (§7.3). |
| **T2** | ¿`terminal.show(false)` enfoca desde la Secondary Side Bar? | ⚪ **F5** | Fallback: `workbench.action.terminal.focus`. |
| **T3** | ¿`workbench.action.chat.open` existe y enfoca el chat? | ⚪ **F5** | `getCommands(true).filter(c => c.includes('chat'))`. Fallback: `toggleAuxiliaryBar` + aviso (§5.1). |
| **T4** | ¿`activeTerminal` cambia cuando el foco pasa al chat? | ⚪ **F5** | Si no cambia → usar el estado `last` de §5.2. |
| **T5** | **Windows:** ¿`where.exe`/`sendText` resuelven `opencode`? | 🟢 **Cerrada** | Devuelve **2 entradas** y la primera no es ejecutable (P-001) → **siempre dentro del shell**, jamás `shellPath`. |
| **T6** | ¿`_EXTENSION_OPENCODE_PORT` legible en `creationOptions.env`? | ⚪ **Obsoleta** | No hay puerto en v5 (P-005). Estado en `Map<Terminal, Estado>`. |
| **T7** | ¿`sendText(texto, false)` llega limpio al prompt del TUI en modo raw? ¿Y `@fichero#L10-20` sigue parseándose? | ⚪ **F5 — PRIORIDAD ALTA** | Es el **único** canal en v2 (P-007) → toda la funcionalidad depende de él (R5). Validar **antes** de construir el resto. Reforzar sanitización (§6); abortar si hay diálogo abierto. |
| **T8** | **OpenCode v1 vs v2**: ¿siguen `/app` y `/tui/append-prompt`? | 🟢 **Cerrada** | **No.** `/app` ausente del spec (P-003); `/tui/*` → 404 (P-007); API prefijada con `/api` + Basic Auth (P-006); background service (P-008). |
| **T9** | ¿Dispara `onDidEndTerminalShellExecution` con `opencode` en PowerShell 5.1? | ⚪ **F5** | Si no dispara, el `exit` encadenado (①) sigue cubriendo. **`cmd.exe` no tiene integración** (P-010). |
| **T10** | ¿El `exit` encadenado cierra la pestaña en el shell por defecto? | ⚪ **F5** | Si no cierra → promover ② (shell integration) a señal primaria. |
| **T11** | ¿Está Git Bash instalado? (es uno de los dos shells con integración en Windows) | ⚪ Rápido | `where.exe bash` o el perfil de terminal configurado en VS Code. |

### 13.3 Datos del entorno — ✅ **COMPLETADO**

| Dato | Valor |
| --- | --- |
| VS Code | **1.141.0** (`x64`, commit `2a59476c9b…`) |
| OpenCode | **v2.0.26** — paquete npm **`@opencode/cli`** → **v2 confirmado** (T8) |
| Topología | **Local en Windows** — sin WSL ni Remote-SSH |
| Shell por defecto | **Windows PowerShell 5.1** — **`pwsh` NO instalado** |

> **Regla de ejecución:** D1–D6 cerradas y **revisadas contra OpenCode v2**. La Fase 0 está completada en todo lo automatizable fuera de VS Code. **Solo quedan T2, T3, T4, T7, T9, T10 — todos exigen F5** (Extension Development Host), porque la API de VS Code no es observable fuera de él. **T7 bloquea el resto de fases.**
