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

Everything the extension does is:

1. open a pseudo-terminal (PTY),
2. run the `opencode` binary in it,
3. paint the resulting screen with xterm.js, using your own VS Code terminal
   settings (font, size, colours).

That is the complete list. There is no fourth step.

### What this extension explicitly does **not** do

| It does not… | Because… |
| --- | --- |
| Reimplement or patch any OpenCode feature | All functionality belongs to the CLI |
| Call any OpenCode or third-party HTTP API | Zero network requests, zero telemetry |
| Parse, interpret or filter the TUI output | The bytes are painted as they arrive |
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

`tuiTabs` is worth a note: it is applied through an environment variable handed
to **this extension's own child process**, so your global
`~/.config/opencode/cli.json` is never read, modified or rewritten.

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
- **No HTTP. No stdout parsing.** The bytes the CLI writes are the bytes xterm
  paints, and the keys you press are the bytes the PTY receives.
- **Single ephemeral instance.** One PTY, one TUI, one section.

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
