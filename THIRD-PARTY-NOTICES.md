# Third-party notices

This extension redistributes or bundles the third-party components listed below.
Each remains licensed by its original authors; nothing here re-licenses it.

---

## node-pty

**License:** MIT
**Copyright:** Microsoft Corporation
**Repository:** https://github.com/microsoft/node-pty
**Redistributed as:** the complete `node_modules/node-pty` package inside the
VSIX (native binaries for every supported platform, JavaScript bindings and the
Windows `conpty.dll` / `OpenConsole.exe`).

`node-pty` is declared as an **external** in the esbuild build, so it is not
inlined into `dist/pty-host.cjs`; the packaged copy is the one that loads at
runtime. It is used to create the pseudo-terminal in which the `opencode`
process runs.

```
MIT License

Copyright (c) Microsoft Corporation

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

**License:** MIT
**Copyright:** The xterm.js authors
**Repository:** https://github.com/xtermjs/xterm.js
**Packages:** `@xterm/xterm`, `@xterm/addon-fit`, `@xterm/addon-webgl`
**Redistributed as:** bundled into `dist/webview.js` (the packages themselves are
excluded from the VSIX because the code is already inlined).

Used to render the OpenCode TUI inside the webview, with the WebGL renderer when
it is available.

---

## OpenCode

**Not redistributed.**

The `opencode` binary is *not* bundled with this extension, is not downloaded by
it, and is not modified by it. It is executed as an ordinary external process,
and all of its functionality, models, agents and behaviour belong entirely to
the OpenCode project.

This extension is **not** affiliated with, endorsed by or connected to OpenCode,
sst, anomalyco or GitHub. For the official OpenCode extension for Visual Studio
Code, see
[`anomalyco/opencode/sdks/vscode`](https://github.com/anomalyco/opencode/tree/dev/sdks/vscode),
released under the MIT License, from which the general approach to the extension
host side of this project was taken.
