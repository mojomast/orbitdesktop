# Verification record

Environment: Linux x64, Node 24.19.0. Date: 19 September 2026.

## Automated

`npm run build`: strict TypeScript check and production Vite bundle.

`npm test`: 12 tests covering:

- Valid/corrupt workspace validation and duplicate ID rejection.
- Nested split/removal and pane identity retention.
- Portrait dimensions and excessive tree/pane rejection.
- Token/dimension validation and hostile Host input.
- Production HTML and security headers.
- Authentication origin and token rejection/acceptance.
- HTTP Host rejection with an actual overridden Host header.
- WebSocket foreign-origin rejection.
- Wrong token rejection without creating a shell.
- Actual PTY command execution, resize (`stty size`), and disconnect cleanup.
- Malformed protocol input rejection.
- Real high-volume shell output pause and resume via ACK flow control.

Tests start a temporary loopback server on port 14318 with an explicitly test-only token. The shell integration commands use Unix tools and are currently Linux/macOS-oriented; native Windows requires equivalent test commands before claiming cross-platform verification.

## Interactive browser checks

Verified startup, monitor selection, flat focus, aspect changes, split creation, keyboard splitter resize, chat stub messaging, adding displays, pitch changes, and restoring saved layout after reload. Also verified preset replacement with confirmation and return from focus to the same spatial monitor.

The cloud test browser has WebGL disabled. Three.js CSS3D monitor transforms and the functional DOM fallback were exercised; the WebGL grid/room could not be visually verified in that browser. Actual terminal commands were verified through the production backend integration tests; credential entry and live xterm typing were not exercised through the cloud browser.

Optional WebMCP registration is feature-detected. The test browser did not provide modelContext, so calls to those optional tools could not be validated. No dependency on WebMCP is required for the UI.

Native Windows/macOS, assistive-technology behavior, touch-device hardware, XR, remote SSH, real agents, and unrestricted browser embedding are not claimed as tested or implemented.
