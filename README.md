# OpenCode Chat Section

**Runs the official OpenCode CLI inside a terminal section stacked right below Copilot Chat.**

`JosueRZS.opencode-chat-section` · MIT · not affiliated with OpenCode or GitHub —
see [DISCLAIMER.md](./DISCLAIMER.md)

A single glance at the Secondary Side Bar: Copilot Chat on top, your OpenCode
session underneath, in the same container, without tabs and without touching the
rest of your layout.

---

## ⚠️ Disclaimer — read this first

**This extension is not affiliated with, endorsed by, sponsored by, or connected
to OpenCode, sst, anomalyco, or GitHub in any way.**

It is an independent, community-made piece of software. The names *OpenCode*,
*GitHub* and *Copilot* belong to their respective owners and are used here purely
to describe compatibility.

**This extension does not implement, extend, modify, wrap or reimplement any
OpenCode functionality.** It is, in short, *a way of looking at the terminal* —
nothing else.

Everything the **terminal** does is:

1. open a pseudo-terminal (PTY),
2. run the `opencode` binary in it,
3. paint the resulting screen with xterm.js, using your own VS Code terminal
   settings (font, size, colours).

That is the complete list. There is no fourth step, and none of it touches the
network.

On top of that — and **entirely separate** — there is a **model usage indicator**
in the status bar. It is the only part of this extension that makes a network
request: one `GET` to `opencode.ai`, authenticated with the credential your
OpenCode CLI has already stored. There is nothing to configure and nothing to
sign up for. Turn it off with `opencodeChat.usage.enabled`. The terminal above
never goes near it. See [Model usage indicator](#model-usage-indicator) and
[PRIVACY.md](./PRIVACY.md).

### What this extension explicitly does **not** do

| It does not… | Because… |
| --- | --- |
| Reimplement or patch any OpenCode feature | All functionality belongs to the CLI |
| Send anything over the network from the terminal | The TUI is a plain PTY: no HTTP, no stdout parsing |
| Phone home, track you, or collect telemetry | The usage indicator is the only outbound request, and it only ever talks to `opencode.ai` |
| Touch your OpenCode configuration | Your config files are never opened or rewritten. Per-session settings travel as an environment variable handed to this extension's own child process. The only thing read from the CLI is the credential it already stores, through `opencode auth export` |
| Ship, bundle or download the `opencode` binary | You install it yourself (or let the helper do it) |
| Create, move or reuse a VS Code terminal | Your bottom-panel shell is left untouched |
| Issue a command against any view other than its own | Restoring the section's position rewrites its own saved order and touches nothing else — see below |
| Collect, store or transmit any data | There is no backend to collect it to |

### Trademarks

*OpenCode* and the OpenCode logo are trademarks of their respective owners.
*Visual Studio Code*, *GitHub* and *GitHub Copilot* are trademarks of Microsoft
Corporation. They are used in this repository **descriptively and nominatively** —
only to say what this software works with — and their use here does not imply any
endorsement, sponsorship, partnership or affiliation. No trademark rights are
granted by the [MIT licence](./LICENSE) that covers this project's source code.
To read the complete legal notice, see [DISCLAIMER.md](./DISCLAIMER.md).

If you want new OpenCode features, model support, agents, authentication or
billing, those come from the CLI itself — not from here.

---

## Data, network and credentials

The complete list. There is no third item.

| | |
| --- | --- |
| **Network** | One `GET https://opencode.ai/zen/go/v1/usage`, at most once every 15 minutes, with a 15-second timeout. Nothing else in this extension opens a socket. |
| **Credential** | Read from your own machine by running `opencode auth export`, the CLI's own read-only command. Sent as `Authorization: Bearer` to `opencode.ai`, and to nowhere else. |
| **Stored locally** | The fallback key — only if you set one — in VS Code's SecretStorage. Never in `settings.json`. |
| **Never leaves your machine** | Your code, your prompts, your files, the contents of the terminal, and every OpenCode setting. |
| **Telemetry** | None. Not even anonymous usage counts. |

The full statement, including what is *not* collected and why, is in
[PRIVACY.md](./PRIVACY.md).

---

## What you get

- **An `OPENCODE` section below Copilot Chat**, inside the same container, in the
  Secondary Side Bar. Drag it anywhere and `OpenCode: Reestablecer posición del
  chat` puts it back.
- **The section *is* a terminal.** Not a chat widget, not an editor tab, not a
  view that pretends. It is a PTY and an xterm.js renderer, with the WebGL
  renderer and the 16 ANSI colours of your active VS Code theme.
- **Your terminal settings are honoured.** Font family, size, line height, cursor
  style and scrollback are read from `terminal.integrated.*`.
- **The session survives.** Hide the side bar, switch files, collapse the section
  — the PTY keeps running and the screen is replayed when you come back.
- **It goes back to a Launch button** when the session ends, instead of silently
  restarting or leaving a dead black rectangle.

## Requirements

- Visual Studio Code **1.140** or later.
- The **`opencode` CLI**, available as `opencode` on your `PATH`. If it is not
  found, the section itself asks whether to install it — inside the section, not
  in a dialog — and detects which package manager you have in order to run its
  official v2 command. The section opens either way; the helper is a
  convenience, not a gate.

## Install

There is **no Marketplace listing yet** — publishing is on hold — so the
supported route today is the packaged `.vsix`:

```powershell
code --install-extension .\opencode-chat-section-0.0.1.vsix
```

Or from the Extensions view: `⋯` → **Install from VSIX…**

Building it from source, if you would rather:

```bash
npm install
npm run build
npx vsce package
```

Note that VS Code disables **auto-update** for extensions installed from a
VSIX — you install each new version by hand. Once a listing exists, the usual
`ext install JosueRZS.opencode-chat-section` will apply.

## Commands

| Command | Default keybinding | What it does |
| --- | --- | --- |
| `OpenCode: Launch` | `Ctrl+Alt+O` (`⌘⌥O` on macOS) | Starts OpenCode in the section |
| `OpenCode: Focus` | `Ctrl+Alt+Shift+O` | Moves focus to the section |
| `OpenCode: Nueva sesión` | `Ctrl+Alt+N` | Starts a new session |
| `OpenCode: Enviar selección` | `Ctrl+Alt+Enter` | Inserts the editor selection into the prompt **without** sending it |
| `OpenCode: Mostrar/ocultar` | `Ctrl+Alt+K` | Toggles Chat + OpenCode together |
| `OpenCode: Ver canal de Salida` | — | Shows the Output channel |
| `OpenCode: Reestablecer posición del chat` | - | Restores the section's saved position below Chat. If it had been dragged, the new order applies after a window reload |
| `OpenCode: Establecer la clave de API de uso (respaldo)` | — | Stores a fallback key for when the CLI has none — normally unnecessary |
| `OpenCode: Actualizar el uso` | — | Re-reads the credential and refreshes the indicator |
| `OpenCode: Borrar la clave de API de uso` | — | Forgets the fallback key |

Keybindings are deliberately chosen to avoid colliding with the official
OpenCode extension. **Both extensions can be installed side by side.**

## Settings

| Setting | Default | Description |
| --- | --- | --- |
| `opencodeChat.cliPath` | `opencode` | Path to the binary. Empty = search `PATH` |
| `opencodeChat.terminalCwd` | `${workspaceFolder}` | Working directory. Supports `${workspaceFolder}` and `~` |
| `opencodeChat.autoLaunch` | `true` | Start OpenCode the first time the section opens |
| `opencodeChat.tuiTabs` | `off` | Session tab strip of the TUI — applied to **this** terminal only |
| `opencodeChat.useConptyDll` | `true` | Use the `conpty.dll` shipped with `node-pty` |
| `opencodeChat.ptySpawnTimeout` | `10000` | ms before the PTY is considered blocked |
| `opencodeChat.autoPromptInstall` | `true` | Ask to install the CLI when it is missing — inside the section |
| `opencodeChat.installMethod` | `auto` | `npm`, `bun`, `pnpm`, `yarn`, `script`, or detect what is available |
| `opencodeChat.chainExit` | `true` | Close the session cleanly when OpenCode exits |
| `opencodeChat.usage.enabled` | `true` | Show the model usage indicator — uses the CLI's own credential |
| `opencodeChat.usage.intervalMinutes` | `15` | Minutes between usage refreshes (minimum 5) |

`tuiTabs` is worth a note: it is applied through an environment variable handed
to **this extension's own child process**, so your global
`~/.config/opencode/cli.json` is never read, modified or rewritten.

## Model usage indicator

An optional readout in the status bar, at the bottom right, next to Copilot's:

```
$(opencode-logo) 42% | 38% | 61%
                   ▲     ▲     ▲
          rolling usage weekly monthly
```

Each window has its own name in the tooltip — *Uso continuo* (a 5-hour sliding
window, not a daily one), *Uso semanal* and *Uso mensual* — translated to the
editor's language, alongside an exact countdown (`3h 25m`, `1d 4h`). Hovering
the item shows the full breakdown — percentage, status and when each window
resets. Clicking it refreshes. If any window is rate-limited the item takes the
warning background.

**It needs no setup.** The key is not something you configure: the extension
reads the credential the OpenCode CLI already has stored, by running
`opencode auth export` — the CLI's own command for printing stored
credentials. If you are already logged into OpenCode, the indicator simply
works.

Where the credential comes from, in order:

1. **The CLI's stored credential** (`opencode auth export`) — the normal path,
   and the one that requires nothing from you.
2. **A manually stored key** — only if the CLI yields none: not installed, not
   authenticated, or `cliPath` pointing somewhere unusable. Set one with
   `OpenCode: Establecer la clave de API de uso (respaldo)`; it lives in the VS
   Code secret store, never in `settings.json`.
3. **Nothing** → the indicator does not appear and no request is made.

Which source is in use is written to the Output channel on every refresh, so
there is never any doubt about which key is talking.

What it is and is not:

- It calls exactly one endpoint, `https://opencode.ai/zen/go/v1/usage`, with a
  15-second timeout. Nothing else in this extension makes a request.
- It reports what OpenCode already knows about your own account. It does not
  read your code, your prompts or your files, and it cannot.
- The OpenCode logo in the indicator is OpenCode's own brand asset, used here
  only to identify whose quota is being shown. See the disclaimer above: this
  extension is not affiliated with OpenCode.
- The credential is read by running a CLI subcommand, not by opening
  `opencode.db` — that database is held by the running service, and reading it
  would mean adding a SQLite driver and coupling to an undocumented schema.
- Turning `opencodeChat.usage.enabled` off removes the item and stops the timer.

The TUI itself does not participate in any of this. It remains a plain PTY.

## Diagnostics

Everything is reported through the standard Output channel — the same place any
other extension reports:

> **View → Output → “OpenCode Chat”**

A backup log with synchronous writes is kept at

```
%TEMP%\opencode-chat\opencode-chat.log      (Windows)
$TMPDIR/opencode-chat/opencode-chat.log     (macOS / Linux)
```

It exists because the Output channel lives inside the extension host: if the host
hangs, its last lines are lost. The file survives.

## What it writes on your machine

The list is short, and it is the whole list.

| Where | What | Why |
| --- | --- | --- |
| `<temp>/opencode-chat/opencode-chat.log` | Plain-text log, appended | So the last lines survive a hung extension host — see [Diagnostics](#diagnostics) |
| VS Code SecretStorage | Your fallback usage key — only if you set one | Encrypted by VS Code's own credential store. Never written to `settings.json` |
| VS Code global state | Bookkeeping about where the section was placed | So it is moved into the Chat container once, and not on every start |
| Your `settings.json` | Only what you change yourself | Ordinary `opencodeChat.*` settings |

Nothing else is created, and **no file belonging to OpenCode is ever modified**.

## How it works

```
extension host ── spawns ──► dist/pty-host.cjs   (ELECTRON_RUN_AS_NODE=1)
                                  │
                                  └── node-pty ──► ConPTY / pty ──► opencode
                                          ▲
        webview (xterm.js + WebGL) ◄──────┘  raw bytes, both ways
```

- **`node-pty` never runs in the extension host.** It lives in a dedicated child
  process, so a blocked ConPTY cannot freeze VS Code.
- **No HTTP in the terminal. No stdout parsing.** The bytes the CLI writes are
  the bytes xterm paints, and the keys you press are the bytes the PTY receives.
  The one outbound request this extension can make — the usage indicator — lives
  in `src/usage/`, has its own key, its own timeout and its own setting, and
  never enters this path.
- **Single ephemeral instance.** One PTY, one TUI, one section.

The usage indicator's own path:

```
readCliCredential ──► opencode auth export   (~750 ms, memoized 5 min)
                          │  credential table in opencode.db, via the CLI
                          ▼
UsageStatus ── fetch ──► https://opencode.ai/zen/go/v1/usage
     ▲                        │ Authorization: Bearer <cli credential>
     └── status bar ◄─────────┘  aborts after 15 s
```

Fallback key from `SecretStorage` is tried only if the CLI yields none.

## Tests

```
npm test
```

Unit tests over the logic that can be checked without a running editor: shell
resolution, composer sanitisation, terminal style defaults, the diagnostic file
log, the usage API contract, and the manifest itself. They compile `src/` with
`tsc` and run on Node's own test runner — no extra dependencies.

136 tests in 9 files. None of them touches the network, and the whole suite
finishes in about a second. **[tests/README.md](./tests/README.md)** documents the
harness: how the `vscode` stub works, what each suite locks down, how to run a
single file, and how to add a test.

`vscode` does not exist outside the extension host, so `tests/register.ts`
redirects `require("vscode")` to a stub (`tests/support/vscode.ts`) that returns
canned configuration. That is what lets the real production code run under test
instead of a re-implementation of it.

`src/usage/usageContract.ts` is the exception that proves the rule: it imports
`vscode` not at all, so `tests/usage.test.ts` loads it **without** the stub.
That absence is deliberate — if someone adds an API dependency to the contract,
that test stops compiling instead of quietly becoming dependent on the stub.

What is **not** covered here, on purpose: placing the view inside the Chat
container and the PTY lifecycle. Both only behave against a real VS Code, and
mocking the part most likely to break would prove little — those are exercised by
hand with the Extension Development Host (F5).

Regressions pinned by these tests:

| Test | What it protects |
| --- | --- |
| `buildOpencodeCommand` → *NUNCA encadena exit* | Chaining `exit` behind the CLI made OpenCode abort with `Unexpected positional argument`; the TUI never drew. |
| `manifest` → *la vista* | The view id in `package.json` must equal `STATUS_VIEW_ID`, or the move into the Chat container fails silently. |
| `vscode.l10n` → *cada mensaje del fuente tiene traducción* | A missing key does not fail the build; it silently falls back to English. |
| `FileLog` → *lo que se escribe llega íntegro a disco* | The Output channel is asynchronous; the file is the only record that survives a hang. |
| `manifest` → *no hay eventos onView redundantes* | VS Code generates `onView:` from `contributes.views`; declaring them by hand duplicates activation. |
| `describeReset` → *cruza de horas a días en 24* | Rounding to the nearest put a reset 23 h 59' away at "1 d": it crossed the `< 24` boundary and reported the wrong window. |
| `parseUsage` → *rechaza el payload si falta una ventana* | Rendering a guessed 0% would tell the user they had full quota when the reading had simply failed. |
| `buildAuthExportCommand` → *rechaza rutas con comillas dobles* | `cliPath` reaches cmd.exe through the shell; `"` closes the quote and lets a crafted path append a second command. `%` expands even inside quotes. |
| `manifest` → *cada id de icono cumple el patrón de dos segmentos* | VS Code rejects a single-segment icon id (`opencode`) with a console warning and never registers the glyph — the id must be `component-iconname`. |
| `manifest` → *el id contribuido se usa realmente en el código* | Declaring an icon and referencing a different one makes the status bar print the literal text instead of the logo. |

### Regenerating the status bar icon

The OpenCode logo in the status bar is a **font glyph**, not an SVG. VS Code's
`StatusBarItem.text` understands `$(icon-id)` but no arbitrary path, so the only
official way in is `contributes.icons`, and that contribution point wants a
font — extension `.woff` or `.ttf`, with the glyph at a private-use codepoint.

`resources/opencode-icons.woff` is therefore generated, never hand-edited:

```bash
npm run build:icon
```

The script lifts the square ring out of OpenCode's own favicon and writes the
WOFF. The two libraries it needs (`opentype.js`, `ttf2woff`) are
devDependencies, used only when the icon changes, and both are excluded from
the VSIX — nobody installing the extension downloads them.

## Troubleshooting

**The section does not appear.**
Check View → Output → “OpenCode Chat”. The section lives inside the Chat
container; if Copilot Chat has not registered its container yet, placement is
deferred to the next start.

**The section is in the wrong place.**
Run `OpenCode: Reestablecer posición del chat`. If it reports that it could not
reorder, the Output channel records exactly which step failed.

**“opencode not found”.**
Set `opencodeChat.cliPath` to the absolute path of the binary, or accept the
offer the section shows with the exact command it will run.

**The screen looks corrupted or frozen on Windows.**
Turn off `opencodeChat.useConptyDll` and relaunch.

## Compatibility

This extension is an **alternative**, not a replacement. It does not compete with
the official OpenCode extension for VS Code and does not share code, commands,
keybindings or configuration with it. Installing both is fine and supported.

## Third-party components

This extension redistributes the following, each under its own licence, with the
licence text reproduced verbatim in
[THIRD-PARTY-NOTICES.md](./THIRD-PARTY-NOTICES.md):

- **node-pty** — MIT — pseudo-terminal bindings
- **xterm.js**, **@xterm/addon-fit**, **@xterm/addon-webgl** — MIT — terminal
  rendering

OpenCode itself is **not** redistributed: it is not bundled, not downloaded and
not modified, only executed.

## License

[MIT](./LICENSE) © JosueRZS.

**The MIT licence covers this project's source code only.** It grants no rights
over any third-party trademark, logo or brand asset — including
`resources/opencode-icons.woff`, which is generated from OpenCode's own logo and
is used nominatively. See
[DISCLAIMER.md](./DISCLAIMER.md#2-trademarks-and-brand-assets).

### Attribution

The pattern of hosting the OpenCode CLI in a terminal section, and the general
approach to the extension host side of the problem, were taken from the official
OpenCode extension for VS Code —
[`anomalyco/opencode/sdks/vscode`](https://github.com/anomalyco/opencode/tree/dev/sdks/vscode),
released under the MIT License.

That project is the work of the OpenCode authors. This repository is not, and is
not intended to become, part of it.

## Documentation

| Document | What it answers |
| --- | --- |
| [DISCLAIMER.md](./DISCLAIMER.md) | Affiliation, trademarks, brand assets, warranty, support |
| [PRIVACY.md](./PRIVACY.md) | What leaves your machine, where it goes, and what never does |
| [THIRD-PARTY-NOTICES.md](./THIRD-PARTY-NOTICES.md) | Every redistributed component and its licence, verbatim |
| [CHANGELOG.md](./CHANGELOG.md) | What changed, and when |
| [tests/README.md](./tests/README.md) | How the suite works, and what it deliberately does not cover |
| [LICENSE](./LICENSE) | MIT — the terms you get this under |

## Credits

- [OpenCode](https://opencode.ai) — the CLI this extension simply *shows*
- [xterm.js](https://github.com/xtermjs/xterm.js) — the renderer
- [node-pty](https://github.com/microsoft/node-pty) — the pseudo-terminal
