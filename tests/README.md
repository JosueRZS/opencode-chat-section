# Tests

How this project is tested, what is covered, and — just as deliberately — what is
not.

```bash
npm test
```

That compiles `src/` and `tests/` to `out/` and runs Node's own test runner over
the result:

```bash
tsc -p tsconfig.test.json
node --test "out/tests/**/*.test.js"
```

Keep the glob **quoted**. Node expands it itself; on Windows, PowerShell would
otherwise try to expand it first and pass something Node cannot read.

**136 tests in 9 files, in about a second.** And zero test dependencies: the
runner is `node:test` and the assertions are `node:assert/strict`, both part of
Node. Nothing to install, nothing to keep in step with a version bump.

---

## What is tested — and what is not

The split is deliberate, and it is the most important thing to know about this
suite.

| | |
| --- | --- |
| **Tested automatically** | Pure logic: parsing, formatting, path and command building, translation coverage, installer selection, log behaviour, and the manifest itself. Anything that takes an input and returns an output. |
| **Verified by hand (F5)** | Anything that needs a live editor: where a view ends up, whether the hot view move took effect, what the PTY does at spawn time, what xterm.js paints after a resize. |

The second row is not laziness. A suite built on `@vscode/test-electron` would
download a real VS Code, launch it, and still not be able to assert the one thing
that actually breaks in this extension: **the workbench reordering its own view
containers**, which is undocumented behaviour that has changed between releases.
The cost would be a large dependency and a slow, flaky pipeline, in exchange for
a green tick that does not predict reality.

So the two halves are complementary. The suite locks down the logic that has no
runtime to catch it; F5 plus the Output channel covers everything the suite
structurally cannot reach. See *Manual verification* at the end.

## How `vscode` is faked

`src/` imports `vscode`, which does not exist outside the extension host — Node
throws `Cannot find module 'vscode'` the moment any file under `src/` is loaded.
Rather than mock each module, the name is intercepted at the module resolver:

```
tests/register.ts    require("vscode")  ──▶  tests/support/vscode.ts
```

`register.ts` hooks `Module._resolveFilename`, the single point every `require`
in CommonJS passes through — the same technique the official extension test
suites use. Because Node caches modules by resolved filename, `src/` and the test
file get the **same object**; there is no shadow copy that can drift.

Any test file that reaches a module importing `vscode` must import `./register`
on its **first line**, before anything from `src/`:

```ts
import "./register";
```

In CommonJS, `require` runs in the order the imports appear, so being first is
what makes it work.

`tests/support/vscode.ts` implements only the surface the logic under test
actually touches: `workspace.getConfiguration`, `workspace.workspaceFolders`,
`workspace.asRelativePath`, `env.shell`, `window.activeTextEditor`, the two
message functions, and `l10n.t`. It is thin on purpose — if production code
starts using another part of the API, the failure lands **in the stub**, where
the cause is obvious, instead of turning into an obscure assertion failure.

The stub also exposes a mutable `state` object and a `reset()`. Call `reset()` in
`beforeEach`: settings, workspace folders and recorded messages all live in that
one object, and would otherwise leak from one test into the next.

### The one file that must *not* import it

`src/usage/usageContract.ts` — the part that knows the shape of the usage API —
imports no editor API at all, and `tests/usage.test.ts` deliberately loads it
**without** the stub. If anyone ever adds a `vscode` dependency to the contract,
that test file stops compiling, loudly, instead of quietly becoming dependent on
the stub. The absence is the assertion.

## The suites

| File | Tests | What it locks down |
| --- | ---: | --- |
| `usage.test.ts` | 23 | `parseUsage`, `describeReset`, `httpFailure`, `USAGE_URL`, `WINDOW_ORDER` |
| `shell.test.ts` | 29 | `resolveShell`, `buildOpencodeCommand`, `resolveCwd`, `opencodeTuiEnv`, `envWithPath` |
| `manifest.test.ts` | 21 | `package.json` itself: titles, activation, commands, keybindings, the view, the icon |
| `opencodeInstall.test.ts` | 16 | The installer catalogue and `pickInstaller` |
| `cliCredential.test.ts` | 14 | `parseAuthExport`, `buildAuthExportCommand` |
| `context.test.ts` | 11 | `sanitizeForComposer`, `buildFileRef`, `sendSelection` |
| `filelog.test.ts` | 8 | `FileLog` — the diagnostic file |
| `terminalConfig.test.ts` | 8 | `readTerminalStyle` — the user's terminal settings |
| `l10n.test.ts` | 6 | Translation coverage of every runtime message |

A few notes that do not fit in a table:

- **`manifest.test.ts` is the one that earns its keep.** It reads
  `package.json` and asserts things VS Code itself would only tell you by
  failing at runtime: that every `%key%` has an entry in both language bundles
  and no orphan keys remain, that VS Code has not been handed an `onView:`
  activation event it already generates, that the contributed icon id matches
  the pattern the workbench actually accepts, and that only the five agreed
  keybindings exist.
- **`shell.test.ts` is partly platform-specific.** The Windows cases
  (`PowerShell profiles`, `cmd`, `%PATH%`) are skipped elsewhere with
  `{ skip: !onWindows }` rather than asserted for every platform, because
  asserting Windows behaviour on Linux would only test the mocks.
- **`usage.test.ts` never touches the network.** It tests the *contract*: what
  counts as a usable payload, what a failure means, and how a reset time is
  described. The request itself is a few lines in `usageStatus.ts` and is
  verified by running the extension.

## Adding a test

1. If the code under test imports `vscode`, start the file with
   `import "./register";`. If it does not, **do not** import it — that omission
   is a real assertion, and `usage.test.ts` exists to keep it honest.
2. Test a pure function. If what you want to test needs a live editor, it belongs
   in the manual list below, not here.
3. No new dependencies.
4. `node:test` + `node:assert/strict`, and a name that says what it locks down —
   the style of the existing tests is the house style.
5. If the logic needs another part of the `vscode` API, add it to the stub. A
   stub that has to grow is a signal worth reading, not an obstacle.

Run everything again before committing:

```bash
npm test
```

## Manual verification

The paths the suite cannot reach, checked with the Extension Development Host
(**F5**) and the Output channel **View → Output → "OpenCode Chat"**:

- The section appears **below Copilot Chat** in the Secondary Side Bar, and comes
  back there after a restart.
- Dragging the section elsewhere, then running `OpenCode: Reestablecer posición
  del chat`, puts it back **without disturbing Copilot Chat's conversation**.
- The TUI draws, and redraws correctly after hiding and re-showing the section —
  no black gap, no wrapped text.
- With `opencode` off the `PATH`: the install question appears **inside the
  section**, `Sí` installs it, and `Launch` does not ask again.
- After `/exit`, the section returns to the Launch button.
- `$(opencode-logo)` renders as the logo in the status bar, not as literal text.

Regressions already pinned by a test are listed in the
[main README](../README.md#tests), next to the story of what each one broke.
