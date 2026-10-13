# Orbit IRC

An ircd, an IRC client library and CLI, and an Orbit web app with a websocket bridge, all in one Node.js (>=18) workspace. There are no native dependencies.

## Layout

- `packages/protocol`: shared parser and serializer (`parseMessage`, `serializeMessage`), numeric reply constants (`RPL`, `ERR`), RFC 1459 casemapping (`ircLower`, `ircEquals`), and helpers (`splitLines`, `parsePrefix`, `isValidNick`, `isChannelName`).
- `packages/ircd`: the IRC server.
- `packages/client`: the client library and CLI.
- `packages/orbit-app`: the websocket bridge and web UI.
- `integration/`: cross-component tests (client to ircd, and bridge to ircd).
- `scripts/run-tests.js`: the root test runner.

## Conventions

- Code is ESM (`"type": "module"`), and tests use the built-in `node:test` and `node:assert/strict` modules.
- Packages import each other by relative path (for example `../../protocol/src/index.js`), so tests work without `npm install`.
- Test files go in `packages/<pkg>/test/*.test.js` or `integration/*.test.js`.
- Ports and hosts are always configurable. Tests listen on port 0 and read the real port from `address()`. Every test must close its servers and sockets so the process can exit.
- The ircd uses RFC 1459 casemapping for nicks and channels.
- Round-tripping is semantic, not byte-exact: `serializeMessage` drops the explicit `:` on a lone trailing param, so `PING :token` serializes as `PING token`. `parseMessage(serializeMessage(m))` always deep-equals `m`, so tests must compare parsed messages rather than raw bytes.

## Testing

Run `npm test` at the workspace root to run every unit and integration test. The runner exits non-zero when it finds no test files, so a green run always means tests actually ran.
