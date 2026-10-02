# Third-party notices

Bundled frontend components retain their original licenses. Other dependencies are installed by npm and include their own notices.

Production builds also emit `third-party-notices.txt`, containing this document,
the installed runtime dependencies' root license/notice files, and the reviewed
canvas-font notices. Preserve that file when distributing the built client.

## Optional technology integrations

The development feature set pins these libraries. Heavy UI modules and engines are
loaded on demand; model weights and external execution runtimes are provisioned
separately. A library license does not license every model it can load.

| Component | Pinned version | License / notice |
| --- | --- | --- |
| A2UI Lit and web core | 0.12.0 | Apache-2.0; packaged `LICENSE` |
| A2UI markdown-it | 0.2.0 | Apache-2.0; packaged `LICENSE` |
| DuckDB-Wasm | 1.32.0 | MIT; upstream notice reproduced below |
| Transformers.js | 4.3.0 | Apache-2.0; ONNX Runtime and other dependencies retain separate notices |
| sqlite-vec | 0.1.9 | MIT OR Apache-2.0; MIT option reproduced below |
| Lexical and `@lexical/*` | 0.52.0 | MIT; Meta Platforms, Inc. and affiliates |
| Excalidraw | 0.18.1 | MIT; upstream notice reproduced below; fonts have separate licenses |
| React and React DOM | 18.3.1 | MIT; Meta Platforms, Inc. and affiliates |
| MCP ext-apps | 2.0.3 | Packaged `LICENSE` describes MIT → Apache-2.0 transition; non-spec documentation CC-BY-4.0 |
| MCP client and core | 2.2.0 | Retain each package's complete `LICENSE`, not only its package.json label |
| Zod | 4.6.5 | MIT |
| OpenTelemetry API / trace-base SDK | 1.9.1 / 2.11.0 | Apache-2.0 |
| Playwright core | 1.58.0 | Apache-2.0; retain packaged `NOTICE` and `ThirdPartyNotices.txt` |

Canvas publication uses a reviewed font allowlist rather than copying the complete
Excalidraw font directory. See [exact font notices](licenses/EXCALIDRAW_FONTS.txt)
and [canvas compatibility](CANVAS.md). The old packaged Liberation font is not
treated as Liberation2/OFL or published by Orbit's font asset pipeline.

The MIT notices below cover the specified upstream projects. Their published npm
archives omit a root license file, so the notices were retrieved from the exact
upstream release tags:

- [DuckDB-Wasm v1.32.0](https://github.com/duckdb/duckdb-wasm/blob/v1.32.0/LICENSE)
- [Excalidraw v0.18.1](https://github.com/excalidraw/excalidraw/blob/v0.18.1/LICENSE)
- [sqlite-vec v0.1.9, MIT option](https://github.com/asg017/sqlite-vec/blob/v0.1.9/LICENSE-MIT)

```text
DuckDB-Wasm: Copyright 2018-2025 Stichting DuckDB Foundation
Excalidraw: Copyright (c) 2020 Excalidraw
sqlite-vec: Copyright (c) 2024 Alex Garcia
Lexical, React and React DOM: Copyright (c) Meta Platforms, Inc. and affiliates.

MIT License

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


## three

```text
The MIT License

Copyright © 2010-2025 three.js authors

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in
all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
THE SOFTWARE.

```


## @xterm/xterm

```text
Copyright (c) 2017-2019, The xterm.js authors (https://github.com/xtermjs/xterm.js)
Copyright (c) 2014-2016, SourceLair Private Company (https://www.sourcelair.com)
Copyright (c) 2012-2013, Christopher Jeffrey (https://github.com/chjj/)

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in
all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
THE SOFTWARE.

```


## @xterm/addon-fit

```text
Copyright (c) 2019, The xterm.js authors (https://github.com/xtermjs/xterm.js)

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in
all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
THE SOFTWARE.

```
