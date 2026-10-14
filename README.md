# OpenCode Chat (Side Bar)

**Runs the official OpenCode CLI inside a terminal section stacked right below Copilot Chat.**

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

On top of that — and **entirely separate** — there is an optional **model usage
indicator** in the status bar. It is the only part of this extension that makes
a network request; it talks only to `opencode.ai`; and it does nothing at all,
not even appearing on screen, until you save an API key for it. The terminal
above never goes near it. See [Model usage indicator](#model-usage-indicator).

### What this extension explicitly does **not** do

| It does not… | Because… |
| --- | --- |
| Reimplement or patch any OpenCode feature | All functionality belongs to the CLI |
| Send anything over the network from the terminal | The TUI is a plain PTY: no HTTP, no stdout parsing |
| Phone home, track you, or collect telemetry | The usage indicator is the only outbound request, and it is off until you configure it |
| Read your OpenCode configuration | — |
| Write to `~/.config/opencode/cli.json` | Per-session settings are injected as an environment variable **into this extension's own child process only** |
| Ship, bundle or download the `opencode` binary | You install it yourself (or let the helper do it) |
| Create, move or reuse a VS Code terminal | Your bottom-panel shell is left untouched |
| Collect, store or transmit any data | There is no backend to collect it to |

If you want new OpenCode features, model support, agents, authentication or
billing, those come from the CLI itself — not from here.

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
  found, the extension offers to install it (`npm` or the official script) — but
  the section opens either way; the helper is a convenience, not a gate.

## Install

From the Marketplace:

```
ext install JosueRZS.opencode-vscode-chat
```

Or from a local `.vsix`:

```powershell
code --install-extension .\opencode-vscode-chat-0.0.1.vsix
```

## Commands

| Command | Default keybinding | What it does |
| --- | --- | --- |
| `OpenCode: Launch` | `Ctrl+Alt+O` (`⌘⌥O` on macOS) | Starts OpenCode in the section |
| `OpenCode: Focus` | `Ctrl+Alt+Shift+O` | Moves focus to the section |
| `OpenCode: Nueva sesión` | `Ctrl+Alt+N` | Starts a new session |
| `OpenCode: Enviar selección` | `Ctrl+Alt+Enter` | Inserts the editor selection into the prompt **without** sending it |
| `OpenCode: Mostrar/ocultar` | `Ctrl+Alt+K` | Toggles Chat + OpenCode together |
| `OpenCode: Ver canal de Salida` | — | Shows the Output channel |
| `OpenCode: Reestablecer posición del chat` | — | Puts the section back below Chat |
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
| `opencodeChat.autoLaunch` | `true` | Start OpenCode when the section opens |
| `opencodeChat.focusOnLaunch` | `true` | Focus the section when launching |
| `opencodeChat.tuiTabs` | `off` | Session tab strip of the TUI — applied to **this** terminal only |
| `opencodeChat.useConptyDll` | `true` | Use the `conpty.dll` shipped with `node-pty` |
| `opencodeChat.ptySpawnTimeout` | `10000` | ms before the PTY is considered blocked |
| `opencodeChat.autoPromptInstall` | `true` | Offer to install the CLI when it is missing |
| `opencodeChat.installMethod` | `auto` | `npm` or the official POSIX script |
| `opencodeChat.chainExit` | `true` | Close the session cleanly when OpenCode exits |
| `opencodeChat.usage.enabled` | `true` | Show the model usage indicator — uses the CLI's own credential |
| `opencodeChat.usage.intervalMinutes` | `15` | Minutes between usage refreshes (minimum 5) |

`tuiTabs` is worth a note: it is applied through an environment variable handed
to **this extension's own child process**, so your global
`~/.config/opencode/cli.json` is never read, modified or rewritten.

## Model usage indicator

An optional readout in the status bar, at the bottom right, next to Copilot's:

```
$(opencode) 42% · 38% · 61%
             ▲      ▲      ▲
        5 h rolling  weekly  monthly
```

Hovering it shows the full breakdown — percentage, status and when each window
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
install prompt.

**The screen looks corrupted or frozen on Windows.**
Turn off `opencodeChat.useConptyDll` and relaunch.

## Compatibility

This extension is an **alternative**, not a replacement. It does not compete with
the official OpenCode extension for VS Code and does not share code, commands,
keybindings or configuration with it. Installing both is fine and supported.

## Third-party components

This extension redistributes the following, each under its own license — see
[THIRD-PARTY-NOTICES.md](./THIRD-PARTY-NOTICES.md):

- **node-pty** — MIT — pseudo-terminal bindings
- **xterm.js**, **xterm-addon-fit**, **xterm-addon-webgl** — MIT — terminal
  rendering

## License

[MIT](./LICENSE) © JosueRZS.

### Attribution

The pattern of hosting the OpenCode CLI in a terminal section, and the general
approach to the extension host side of the problem, were taken from the official
OpenCode extension for VS Code —
[`anomalyco/opencode/sdks/vscode`](https://github.com/anomalyco/opencode/tree/dev/sdks/vscode),
released under the MIT License.

That project is the work of the OpenCode authors. This repository is not, and is
not intended to become, part of it.

## Credits

- [OpenCode](https://opencode.ai) — the CLI this extension simply *shows*
- [xterm.js](https://github.com/xtermjs/xterm.js) — the renderer
- [node-pty](https://github.com/microsoft/node-pty) — the pseudo-terminal
