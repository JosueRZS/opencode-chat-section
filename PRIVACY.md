# Privacy

**Short version:** this extension has no backend, no telemetry and no analytics.
It makes exactly one kind of outbound request — a read-only quota lookup against
`opencode.ai` — and you can switch that off with a single setting.

Applies to version 0.0.1. Last reviewed 2026-10-15.

---

## The one outbound request

| | |
| --- | --- |
| **When** | At most once every 15 minutes by default (`opencodeChat.usage.intervalMinutes`, minimum 5), plus once when you run `OpenCode: Actualizar el uso` |
| **Where** | `https://opencode.ai/zen/go/v1/usage` — a constant in the source, not built from configuration |
| **Method** | `GET`, no query string |
| **Headers** | `Authorization: Bearer <credential>`, `x-opencode-session: vscode-chat-section`, `User-Agent: opencode-chat-section` |
| **Timeout** | 15 seconds, after which the request is aborted |
| **Body** | None. Nothing is uploaded, at any point, ever |
| **Purpose** | Read the used percentage and reset time of your own quota windows |

No other part of this extension opens a socket. The terminal in the section is a
plain PTY: the bytes the OpenCode CLI writes go to `xterm.js`, and the keys you
press go back to the PTY. Neither passes through any networking code, because
there is none on that path.

## The credential

The indicator does not ask you for a key, because the OpenCode CLI already has
one and there is no reason to make you configure it twice.

1. The extension runs `opencode auth export` — the CLI's own read-only command
   for printing stored credentials — as a child process on your machine.
2. It takes the active entry's key out of the JSON that command prints.
3. It sends that key to `opencode.ai` in the `Authorization` header, and to
   nowhere else. There is no second host anywhere in the code.

It is read this way rather than by opening `opencode.db` because that database is
held by the running OpenCode service; reading it would mean bundling a SQLite
driver and depending on an undocumented schema.

**The value is never written to `settings.json`, never logged and never
displayed.** The log records *which source* a key came from — CLI or fallback —
never the key itself.

If you would rather not rely on the CLI, you can store a key yourself with
`OpenCode: Establecer la clave de API de uso (respaldo)`. It goes into VS Code's
`SecretStorage`, the editor's own credential store, and is used only when the CLI
yields nothing.

## What is not collected

- No analytics, no telemetry, no crash reporting. Not even anonymous counts.
- No reading of your code, your prompts, your files, or the contents of the
  terminal.
- No reading or rewriting of your OpenCode configuration. Per-session settings
  are handed to this extension's **own child process** as an environment
  variable; `~/.config/opencode/` is never opened.
- No identifiers beyond the two fixed strings listed above, which say what client
  is asking and nothing about you.

## What is stored locally

| Where | What | Removed by |
| --- | --- | --- |
| `<temp>/opencode-chat/opencode-chat.log` | Diagnostics, plain text | Deleting the file |
| VS Code `SecretStorage` | Fallback usage key, only if you set one | `OpenCode: Borrar la clave de API de uso` |
| VS Code global state | Bookkeeping about where the section was placed | Uninstalling the extension |

## Third parties

`opencode.ai` is operated by the OpenCode project, not by this extension. A
request to it is governed by their terms and their privacy policy, not by this
document. This extension's only claim is that it sends nothing anywhere else.

## Turning it off

- `opencodeChat.usage.enabled: false` removes the status bar item and stops the
  timer. Nothing else in the extension changes.
- Uninstalling removes the item and stops everything.

## Verifying this yourself

The claim is small enough to check rather than trust. Everything that touches the
network lives in one directory, and the request itself is a single `fetch`:

```
grep -R "fetch(" src/
grep -R "https://" src/
```

`src/usage/usageContract.ts` — the part that knows the shape of the API response
— imports no editor API at all, and `tests/usage.test.ts` loads it **without** the
`vscode` stub. If anyone ever added a network or editor dependency to it, that
test would stop compiling instead of quietly changing behaviour.

## Changes

If a future version makes any new outbound request, this file changes first, and
the [CHANGELOG](./CHANGELOG.md) says so explicitly.
