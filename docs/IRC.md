# IRC

IRC is an Orbit app. Open it from Start, the command palette, or the Orbit menu. It is its own window at `orbit://surface/irc` and uses the Orbit theme.

The window shows whether the server is running, the channel list, the people in the selected channel, the messages, a nick, and join, part, and a composer.

## Server

Orbit's Node server owns the ircd process. **Start server** launches it. **Stop server** ends it. Nothing listens until you start it.

The default bind is `127.0.0.1:6667`. `ORBIT_IRC_HOST` may be `127.0.0.1` or `::1`. `ORBIT_IRC_PORT` may be an integer from 1024 through 65535. The window can choose another port in that range before start. The ircd is not bound on a public address. The browser reaches it through a websocket at `/api/irc` on Orbit's own origin, after the same host token as the rest of Orbit.

## Sources

The agent-built suite is not vendored in this tree yet. Orbit looks for it at `apps/irc/` inside the repo, or at `ORBIT_IRC_SOURCE` when that is set. The directory must contain:

- `packages/protocol`
- `packages/ircd`
- `packages/client`
- `packages/orbit-app`

`packages/ircd` needs a `package.json` `bin` or `main`, or one of `server.js`, `index.js`, `src/server.js`, `src/index.js`, or `bin/ircd.js`. Orbit runs that file with Node. The host and port are `--host`, `--port`, `ORBIT_IRC_HOST`, `ORBIT_IRC_PORT`, `IRC_HOST`, and `IRC_PORT`. The entry has to stay inside the source directory.

Until those packages are present, Start reports that the sources are not installed and does not launch a process. The Orbit window is the client. `packages/orbit-app` is part of the suite Orbit expects; it is not a second window.
