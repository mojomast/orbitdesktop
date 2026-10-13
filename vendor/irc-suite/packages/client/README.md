# @orbit-irc/client

An EventEmitter IRC client library plus a readline CLI. No dependencies beyond Node >= 18 and the shared `packages/protocol` parser.

## Library

```js
import { IrcClient } from '../client/src/index.js';

const client = new IrcClient({ host: '127.0.0.1', port: 6667, nick: 'bob', realname: 'Bob D' });
client.on('registered', () => client.join('#room'));
client.on('message', ({ nick, target, text }) => console.log(`<${nick}> ${text}`));
client.connect();
```

`new IrcClient({ host, port, nick, user, realname, password, autoPong })`
- `nick` is required; `user` and `realname` default to `nick`; `host`/`port` default to `127.0.0.1:6667`.
- `connect()` opens the socket and sends `PASS` (when set), `NICK` and `USER`.
- `autoPong` (default `true`) answers every server `PING` with a `PONG`.

Commands: `join(channel[, key])`, `part(channel[, message])`, `say(target, text)`, `notice(target, text)`, `action(target, text)` (CTCP ACTION, aliased `me`), `topic(channel[, text])` (get when `text` is omitted), `names(channel)`, `who(mask)`, `mode(target[, modes, ...args])`, `setNick(nick)`, `quit([message])`, `close()`.

Also: `send(line)` writes one raw line (throws when not connected), `raw(msg)` serializes a `{ command, params }` object, `members(channel)`, `channelNames()`, `channel(name)`, `isMe(nick)`, `registered`, `nick`, `serverName`.

Events: `connect`, `registered`, `raw`, `message`, `action`, `notice`, `join`, `part`, `kick`, `quit`, `nick`, `topic`, `names` (with `names` tokens and parsed `users`), `namesreply`, `whoreply`, `who`, `mode`, `serverinfo`, `isupport`, `numeric`, `unknown`, `ping`, `pong`, `error`, `close`.

Channel membership is tracked from JOIN/PART/KICK/QUIT/NICK and from NAMES replies, with RFC 1459 casemapping for nick and channel comparison.

`error` carries protocol errors as `{ code, params, text }` and socket failures as `Error`. A no-op listener is installed so an ignored `error` never crashes the process.

## CLI

```sh
node packages/client/src/cli.js --nick bob --host 127.0.0.1 --port 6667 --channel '#room'
```

Flags: `--nick/-n` (required), `--host/-h`, `--port/-p`, `--channel/-c`, `--user`, `--realname/-r`, `--help`.

Commands: `/join`, `/part`, `/msg`, `/me`, `/notice`, `/topic`, `/names`, `/who`, `/mode`, `/nick`, `/quit`, `/help`. Plain text goes to the current channel; with no current channel it is reported and dropped.

`parseCommandLine(line)` and `dispatch(client, state, line)` are exported for testing; `dispatch` returns what it did (`{ action: 'say', target, text }`, and so on) and never touches the network except through the client you pass in.

## Wire format note

Message serialization is semantic, not byte-exact: a single trailing parameter is written without an explicit colon, so `say('#chan', 'hi there')` sends `PRIVMSG #chan :hi there` while `say('#chan', 'single')` sends `PRIVMSG #chan single`. Both parse back identically, so tests should compare parsed messages rather than raw bytes.

## Tests

```sh
node --test packages/client/test/     # or: npm test at the workspace root
```

`test/client.test.js` drives a fake TCP server (port 0) and asserts both directions: what the client writes, and which events it emits for server replies. `test/cli.test.js` covers command parsing, dispatch against a recorder client, and one end-to-end path where CLI input reaches the wire through the library.
