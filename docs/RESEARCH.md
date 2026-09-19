# Research and implementation decisions

Primary documentation consulted 19 September 2026. These are implementation choices for this prototype, not claims of an industry-wide consensus.

## Interactive surfaces in 3D

Three.js CSS3DRenderer transforms DOM nodes and can be combined with WebGL content. It does not share WebGL materials/geometries and documents a 100% browser/display zoom limitation. This led to DOM-based panes, separate rendering layers, and a flat focus mode. Canvas-texture terminals were rejected here because text selection and native input matter more than physically accurate screen lighting.

Source: [Three.js CSS3DRenderer](https://threejs.org/docs/pages/CSS3DRenderer.html).

## Terminal transport and backpressure

xterm's `write` is asynchronous. Its flow-control guide describes acknowledged consumption and high/low watermarks across WebSocket transport. Orbit acknowledges from the xterm write callback, pauses/resumes the PTY, limits buffers, and terminates stalled consumers. Integration tests exercise the pause/resume path with a fast producer.

Source: [xterm.js flow control](https://xtermjs.org/docs/guides/flowcontrol/).

## Terminal trust boundary

xterm's security guide calls for restrictive privileges, controlled frontend assets, safe handling of terminal output, and explicit WebSocket authorization. Orbit bundles frontend dependencies, avoids dynamic third-party scripts/fonts, uses native text insertion, authenticates the WebSocket's first message, validates exact origins and Host values, and binds the backend to loopback. These measures bound the local prototype; they do not replace multi-user isolation or a security audit.

Source: [xterm.js security](https://xtermjs.org/docs/guides/security/).

## Local host portability

node-pty provides real pseudoterminals with input, resize, and output APIs and supports Linux, macOS, and Windows via platform-specific implementations. Orbit's adapter selects PowerShell on Windows and the user's shell on Unix. Only the Linux path was executed here. The native dependency may require a compiler toolchain; a child-process pipe alone would not provide equivalent terminal semantics.

Source: [Microsoft node-pty](https://github.com/microsoft/node-pty).

## Embedded browser behavior

An iframe remains under browser security policy. Its sandbox limits capabilities; a site's `frame-ancestors` policy controls where it may be embedded. Browser-pane restrictions are surfaced honestly with an external-tab option. Orbit does not attempt header stripping, authenticated scraping, or iframe-block detection based on unreliable load events. Remote page zoom is applied to the iframe container rather than attempting cross-origin DOM access.

Sources: [MDN iframe element](https://developer.mozilla.org/en-US/docs/Web/HTML/Reference/Elements/iframe), [MDN CSP frame-ancestors](https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Content-Security-Policy/frame-ancestors).

## Practical conclusions

Keep the workspace schema independent of renderers and host transports. Keep pane IDs stable through geometry changes. Dispose PTYs and render resources explicitly. Treat focus mode as a first-class working surface. Add remote host support only with host identity, authentication, credential storage, and authorization designed together.
