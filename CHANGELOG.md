# Changelog

Notable changes to the **OpenCode Chat Section** extension.
This project follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.0.1]

First release. Not published to the Marketplace; install from a `.vsix` — see the
[README](./README.md#install).

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
- `OpenCode: Reestablecer posición del chat` puts the section back below Chat if
  it had been dragged. It rewrites only its own saved order, and never issues a
  command against another view.

### Model usage indicator

- An optional status bar item showing the `rolling` / `weekly` / `monthly` quota
  windows as percentages, with a breakdown and an exact reset countdown on hover.
  A rate-limited window takes the warning background.
- **No setup.** The credential is the one the OpenCode CLI already stores, read
  with `opencode auth export`. The extension keeps no key of its own: without a
  CLI credential the indicator simply does not appear.
- It is the only outbound request this extension makes: one `GET` to
  `https://opencode.ai/zen/go/v1/usage`, with a 15-second timeout. See
  [PRIVACY.md](./PRIVACY.md).

### Installation helper

- If `opencode` is not on the `PATH`, the **section itself** asks whether to
  install it — a panel inside the section, never a modal dialog.
- The official v2 command is chosen for the package manager actually detected
  (`npm`, `bun`, `pnpm`, `yarn`, or the official script on macOS and Linux), in
  the order published on `opencode.ai/download`.
- The section opens either way. The helper is a convenience, not a gate.

### Process model

- `node-pty` runs in a dedicated child process (`dist/pty-host.cjs` with
  `ELECTRON_RUN_AS_NODE=1`), never inside the extension host, so a blocked
  ConPTY cannot freeze VS Code.
- Uses the `conpty.dll` shipped with `node-pty` by default — the same path VS
  Code's own terminal uses on Windows.
- The PTY is spawned at the webview's real size and re-confirmed before the
  command is typed, so the TUI never lays out for a size nobody asked for.

### Localization

- Spanish is the default language, with English as the source and fallback.
- Command titles and setting descriptions ship in both languages
  (`package.nls.json` / `package.nls.es.json`); runtime messages go through
  `vscode.l10n` with `l10n/bundle.l10n.es.json`.
- The Output channel's diagnostic traces are deliberately **ASCII-only**, so they
  cannot be mangled by a console's encoding.

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
| `OpenCode: Actualizar el uso` | — |

Keybindings are chosen to avoid colliding with the official OpenCode extension;
both can be installed side by side.

### Diagnostics

- Everything is reported through the standard Output channel:
  **View → Output → "OpenCode Chat"**.
- A backup log with synchronous writes is kept in
  `%TEMP%\opencode-chat\opencode-chat.log`, because the Output channel lives in
  the extension host and loses its last lines if the host hangs.

### Tests

- 136 tests in 9 files, on Node's own test runner, with **zero test
  dependencies**.
- Pure logic only: parsing, formatting, command building, translations, installer
  selection, log behaviour, and the manifest itself.
- The `vscode` API is faked by intercepting `require` at the module resolver, so
  the real production code runs under test rather than a re-implementation.
- View placement and PTY lifecycle are **deliberately not** tested — they only
  behave against a real VS Code, and are verified by hand with F5.
- See [tests/README.md](./tests/README.md).

### Documentation, licensing and legal

- [DISCLAIMER.md](./DISCLAIMER.md) — no affiliation, trademarks, brand assets, no
  warranty, no support obligation.
- [PRIVACY.md](./PRIVACY.md) — the complete list of what leaves your machine, and
  what does not.
- [THIRD-PARTY-NOTICES.md](./THIRD-PARTY-NOTICES.md) — every redistributed
  component with its licence reproduced verbatim.
- MIT, with attribution to
  [`anomalyco/opencode/sdks/vscode`](https://github.com/anomalyco/opencode/tree/dev/sdks/vscode)
  for the approach to the extension host side of the problem.
