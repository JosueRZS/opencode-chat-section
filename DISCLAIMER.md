# Disclaimer and legal notice

Version 0.0.1 · last reviewed 2026-10-15

**Short version:** this is independent, unofficial software. It is not made by,
approved by or connected to OpenCode or GitHub, and it comes with no warranty of
any kind.

---

## 1. No affiliation

This extension is **not affiliated with, endorsed by, sponsored by, authorised by
or in any way officially connected to**:

- **OpenCode** (opencode.ai), its authors, or Anomaly / anomalyco / sst, the
  project that develops it;
- **Microsoft Corporation**, **GitHub**, or **GitHub Copilot**;
- any other project, company or organisation named in this repository.

It is community-made software, published by an individual. Nothing here is a
statement on behalf of any of those parties, and none of them has reviewed,
tested or approved this code.

## 2. Trademarks and brand assets

*OpenCode* and the OpenCode logo are the property of their respective owners.
*Visual Studio Code*, *GitHub* and *GitHub Copilot* are trademarks of Microsoft
Corporation.

Those names and marks appear in this repository **descriptively and
nominatively** — only to state what this software works with, the way a manual
names a brand of fuel. Their use implies no endorsement and grants no licence.

- The status bar icon is a font glyph generated from OpenCode's own logo. It is
  used solely to identify whose quota the indicator is showing. It conveys no
  permission beyond that, and it will be removed on request from the rights
  holder.
- **The MIT licence in [LICENSE](./LICENSE) covers this project's source code
  only.** It grants no rights over any third-party trademark, logo or brand
  asset — it could not, because they are not ours to license.

## 3. What this extension is, and what it is not

It is a **presentation of a terminal**. It opens a pseudo-terminal, runs the
`opencode` binary you already have installed, and paints the result with
xterm.js.

It does **not** implement, reimplement, extend, patch, wrap, fork or replace any
part of OpenCode. Every feature, model, agent, authentication method and billing
arrangement belongs to the CLI and to the OpenCode project, and is governed by
their terms — not by this document.

It is **not** the official extension. The official one lives at
[`anomalyco/opencode/sdks/vscode`](https://github.com/anomalyco/opencode/tree/dev/sdks/vscode).
If you want support, guarantees or a roadmap, that is the project to ask.

Both can be installed side by side. They share no code, commands, keybindings or
configuration.

## 4. Your account, your usage, your bill

The usage indicator reports what OpenCode already knows about **your own**
account, using the credential your own CLI already stores. It does not create
accounts, grant access, change plans or influence your quota in any way.

Any cost you incur with OpenCode is between you and them. This project has no
relationship with that billing, sees nothing beyond the percentages the API
returns, and cannot help you with it.

## 5. No warranty

This software is provided **"as is", without warranty of any kind**, express or
implied, as stated in full in the [LICENSE](./LICENSE).

It runs a third-party program inside a pseudo-terminal on your machine. The
authors of this extension do not control that program, do not audit it, and are
not responsible for anything it does — including anything it writes to disk, data
it sends, or commands it runs at your request.

Use it at your own risk, and keep backups of anything you care about.

## 6. No support obligation

This is a personal project maintained on a best-effort basis. There is no service
level, no guaranteed response time, and no commitment to fix, update or continue
it. Issues and pull requests are welcome and may go unanswered.

## 7. Third-party components

`node-pty` and `xterm.js` are redistributed under their own licences, reproduced
verbatim in [THIRD-PARTY-NOTICES.md](./THIRD-PARTY-NOTICES.md). Each remains the
property of its authors.

## 8. Reporting a problem with this notice

If you hold rights to something referenced here and believe this repository uses
it incorrectly,
[open an issue](https://github.com/JosueRZS/opencode-chat-section/issues). It will
be addressed.
