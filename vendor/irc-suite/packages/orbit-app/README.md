# @orbit-irc/orbit-app

The Orbit web app: an HTTP server that serves a static UI and upgrades `/ws` into
a websocket bridge. Every websocket session owns one `IrcClient` connected to the
configured ircd, so the browser gets a live view of channels, members and messages
without any build step and without dependencies (`node:http` plus the packages in
this repo).

## Run it

```sh
node bin/orbit-app.js --ircd-host 127.0.0.1 --ircd-port 6667 --nick orbit-web --port 8080
```

Flags: `--port` (default 8080), `--host` (default 127.0.0.1), `--ircd-host`,
`--ircd-port` (default 6667), `--nick` (default orbit-web), `--channel` (optional
channel to join on connect). Each flag also reads `ORBIT_APP_<FLAG>` from the
environment, so `ORBIT_APP_IRCD_PORT=6667` works.

Then open `http://127.0.0.1:8080/`. The UI has three panes: channels on the left,
messages in the middle with a composer, users on the right.

## HTTP routes

| route | purpose |
|---|---|
| `GET /` | the UI (`public/index.html`) |
| `GET /app.js`, `GET /style.css` | the UI's static assets |
| `GET /healthz` | JSON `{ ok, sessions, ircd: { host, port } }` |
| `GET /ws` (upgrade) | the websocket bridge; a non-upgrade request 404s |
| anything else | 404 |

An upgrade request to another path 404s; an upgrade to `/ws` without
`Sec-WebSocket-Key` 400s.

## Bridge protocol

Server to browser, one JSON object per frame, always with a `type`:

- `registered` - `{ nick, server }`
- `message` - `{ nick, user, host, target, text, channel, action }` (an ACTION arrives with `action: true`)
- `notice` - `{ nick, target, text }`
- `join`, `part`, `kick` - `{ nick, channel, text, self }`
- `quit` - `{ nick, text }`
- `nick` - `{ oldNick, nick, self }`
- `topic` - `{ channel, text, nick, absent }`
- `names` - `{ channel, users: [{ nick, prefix, op, voice }] }`
- `who` - `{ mask, users: [{ nick, user, host, realname, op, away }] }`
- `mode` - `{ target, modes, params }`
- `error` - `{ error, code, params }` for either an IRC error numeric or a rejected command
- `state` - `{ nick, registered, current, channels: [{ name, topic, users }] }`, sent after joins, parts, nicks, names, registration and disconnects so the UI can redraw its panes
- `ack` - `{ effect, ... }` after a browser command is applied
- `close` - the IRC session ended

Browser to server:

- `{"cmd":"join","channel":"#room"}` (optional `key`)
- `{"cmd":"say","text":"hello"}` or `{"cmd":"say","target":"#other","text":"hello"}`
- `{"cmd":"part","channel":"#room","text":"bye"}`
- `{"cmd":"topic","text":"new topic"}` (omit `text` to query)
- `{"cmd":"me","text":"waves"}`, `{"cmd":"notice","target":"a","text":"x"}`
- `{"cmd":"names","channel":"#room"}`, `{"cmd":"who","mask":"#room"}`
- `{"cmd":"mode","target":"#room","modes":"+o alice"}`
- `{"cmd":"nick","nick":"bob2"}`, `{"cmd":"quit","text":"bye"}`
- `{"cmd":"raw","line":"WHO #room"}` for anything not mapped yet

Commands without a channel use the channel the session is currently in; `say`
with no channel and nothing joined is refused with `{"type":"error"}` rather
than guessed. Invalid JSON, a non-object, an unknown `cmd` and missing fields all
come back as `{"type":"error","error":"..."}`.

## Library use

```js
import { createApp } from '../orbit-app/src/server.js';
const app = createApp({ ircd: { host: '127.0.0.1', port: 6667 }, nick: 'orbit-web' });
await app.listen(0, '127.0.0.1');
console.log(app.url('/'));   // http://127.0.0.1:PORT/
```

`app.close()` quits every session, destroys the open websockets and closes the
listener. In tests, pass `clientFactory` to inject a stub IRC client, and listen
on port 0 to read the real port from `app.address()`.

`src/ws.js` is a dependency-free RFC 6455 implementation: `acceptValue` (the
handshake hash), `encodeFrame`/`createFrameParser` (7/16/64-bit lengths, masking,
continuation frames, ping/pong/close) and `createClient`, a small browser-less
websocket client used by the tests.

## Tests

```sh
node --test packages/orbit-app/test/    # or: npm test at the workspace root
```

- `translate.test.js` - event and command translation, state snapshots, `applyCommand`
- `ws.test.js` - the RFC 6455 vector, frame layouts, masking, fragmentation,
  ping/pong, close, oversized lengths, and `createClient` against a real socket
- `http.test.js` - the routes above, the three UI panes in the HTML, refusals for
  bad upgrades, and that each handshake opens its own IRC session
- `bridge.test.js` - commands reaching a stub client, IRC events relayed as JSON,
  state snapshots, rejected commands, the UI reducer/parser, and one end-to-end
  run against the real ircd with a real `IrcClient` peer

Known gap: `MODE +o/-o` is relayed to the UI but does not rewrite the op flags in
the snapshot; op status comes from `NAMES` (and the ircd re-sends `NAMES` on join).
