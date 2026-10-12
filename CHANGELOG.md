# Change Log

All notable changes to the **OpenCode Chat (Side Bar)** extension.

## [0.0.1]

First release.

### The section

- An `OPENCODE` section stacked **below** Copilot Chat in the Secondary Side Bar,
  inside the same Chat container, without tabs and without touching
  `workbench.activityBar.location`.
- The section **is** a terminal: it renders the official OpenCode TUI through
  xterm.js with the WebGL renderer and the 16 ANSI colours of the active VS Code
  theme, using `terminal.integrated` font settings.
- No VS Code terminal is created, moved or reused. The bottom-panel shell of your
  setup is left untouched.
- The TUI session tab strip is disabled **only** for this terminal, through
  `OPENCODE_CLI_CONFIG_CONTENT` injected into the child PTY environment. Your
  global `~/.config/opencode/cli.json` is never modified.
- After every session exit (`/exit`, or the process ending) the section returns to
  its Launch button instead of restarting silently or going blank.

### Process model

- `node-pty` runs in a dedicated child process (`dist/pty-host.cjs` with
  `ELECTRON_RUN_AS_NODE=1`), never inside the extension host, so a blocked
  ConPTY cannot freeze VS Code.
- Uses the `conpty.dll` shipped with `node-pty` by default — the same path VS
  Code's own terminal uses on Windows.

### Commands

| Command | Default keybinding |
| --- | --- |
| `OpenCode: Launch` | `Ctrl+Alt+O` |
| `OpenCode: Focus` | `Ctrl+Alt+Shift+O` |
| `OpenCode: Nueva sesión` | `Ctrl+Alt+N` |
| `OpenCode: Enviar selección` | `Ctrl+Alt+Enter` |
| `OpenCode: Mostrar/ocultar` | `Ctrl+Alt+K` |
| `OpenCode: Ver canal de Salida` | — |
| `OpenCode: Reestablecer posición del chat` | — |

Command titles are localized (`package.nls.json` / `package.nls.es.json`).

### Diagnostics

- Everything is reported through the standard Output channel:
  **View → Output → "OpenCode Chat"**.
- A backup log with synchronous writes is kept in
  `%TEMP%\opencode-chat\opencode-chat.log`, because the Output channel lives in
  the extension host and loses its last lines if the host hangs.
