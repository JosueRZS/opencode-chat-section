# Third-party notices

This extension redistributes or bundles the third-party components listed below.
Each remains licensed by its original authors; nothing in this repository
re-licenses it.

The MIT body is identical in each licence; what differs is the copyright line, so
each component's licence is reproduced in full, verbatim, with its own.

---

## node-pty

| | |
| --- | --- |
| **Version** | 1.1.0 |
| **Licence** | MIT |
| **Copyright** | 2012-2015, Christopher Jeffrey |
| **Repository** | https://github.com/microsoft/node-pty |

**Redistributed as:** the complete `node_modules/node-pty` package inside the
VSIX — native binaries for every supported platform, JavaScript bindings, and the
Windows `conpty.dll` / `OpenConsole.exe`.

`node-pty` is declared as an **external** in the esbuild build, so it is not
inlined into `dist/pty-host.cjs`; the packaged copy is what loads at runtime. It
creates the pseudo-terminal in which the `opencode` process runs.

```
Copyright (c) 2012-2015, Christopher Jeffrey (https://github.com/chjj/)

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

---

## xterm.js and addons

| | |
| --- | --- |
| **Versions** | `@xterm/xterm` 6.0.0, `@xterm/addon-fit` 0.11.0, `@xterm/addon-webgl` 0.19.0 |
| **Licence** | MIT |
| **Repository** | https://github.com/xtermjs/xterm.js |

**Redistributed as:** compiled into `dist/webview.js`. The packages themselves are
excluded from the VSIX because their code is already inlined there.

Used to render the OpenCode TUI inside the webview, with the WebGL renderer when
it is available.

```
Copyright (c) 2017-2019, The xterm.js authors (https://github.com/xtermjs/xterm.js)
Copyright (c) 2014-2016, SourceLair Private Company (https://www.sourcelair.com)
Copyright (c) 2012-2013, Christopher Jeffrey (https://github.com/chjj/)

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

---

## Brand asset: the status bar icon

`resources/opencode-icons.woff` is a font glyph generated from OpenCode's own
logo, by `npm run build:icon`.

**It is not covered by the MIT licence of this repository, and it is not claimed
to be.** It is a third-party brand asset, used nominatively and solely to
identify whose quota the status bar indicator is showing. It implies no
endorsement and grants no licence. See
[DISCLAIMER.md](./DISCLAIMER.md#2-trademarks-and-brand-assets); it will be
removed on request from the rights holder.

---

## Not redistributed

None of the following ships in the VSIX, and none of it is required on a user's
machine:

- **OpenCode** — the `opencode` binary. It is *not* bundled, *not* downloaded,
  and *not* modified by this extension. It is executed as an ordinary external
  process, and all of its functionality, models, agents and behaviour belong
  entirely to the OpenCode project.
- **Visual Studio Code**, **GitHub**, **GitHub Copilot** — referenced, never
  redistributed.
- **Build-time-only packages** — `esbuild`, `typescript`, `@vscode/vsce`,
  `opentype.js`, `ttf2woff`, `@types/node`, `@types/vscode`, `undici-types`.
  Development dependencies, all excluded by `.vscodeignore`. `opentype.js` and
  `ttf2woff` are used only when the icon font is regenerated, which never happens
  at install time.

---

## Attribution

The pattern of hosting the OpenCode CLI in a terminal section, and the general
approach to the extension host side of the problem, were taken from the official
OpenCode extension for VS Code —
[`anomalyco/opencode/sdks/vscode`](https://github.com/anomalyco/opencode/tree/dev/sdks/vscode),
released under the MIT License. That project is the work of the OpenCode authors.
This repository is not, and is not intended to become, part of it.

This extension is **not** affiliated with, endorsed by or connected to OpenCode,
sst, anomalyco or GitHub. The full statement is in
[DISCLAIMER.md](./DISCLAIMER.md).
