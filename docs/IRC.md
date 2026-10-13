# IRC

IRC is an Orbit app. Open it from Start, the command palette, or the Orbit menu. It is its own window at `orbit://surface/irc` and uses the Orbit theme.

The window shows whether the server is running, the channel list, the people in the selected channel, the messages, a nick, and join, part, and a composer.

## Server

Orbit's Node server owns the ircd process. **Start server** launches it. **Stop server** ends it. Nothing listens until you start it.

The default bind is `127.0.0.1:6667`. `ORBIT_IRC_HOST` may be `127.0.0.1` or `::1`. Any other host is rejected, so the ircd is not a public listener. `ORBIT_IRC_PORT` may be an integer from 1024 through 65535. The window can choose another port in that range before start. The browser reaches it through a websocket at `/api/irc` on Orbit's own origin, after the same host token as the rest of Orbit. `allowedRequest` rejects a foreign `Origin`. That is the proxy: nothing talks to the ircd except this authenticated bridge.

`ORBIT_IRC_TARGETS` is a comma-separated allowlist of channels and nicks. The default is `#orbit`. Join, part, owner messages, and agent posts all refuse a target that is not on that list, so the bridge is not an open relay.

## Messages and agent posts

The window is a same-origin Orbit surface, not an embedded page. Orbit's host content security policy sets `frame-ancestors 'none'`, which is stricter than `'self'` and stops another site from framing Orbit. IRC text is rendered as text. There is no HTML and no media preview.

Channel text stays in the IRC window. It is not copied into an agent prompt and it is not treated as an instruction.

An agent that wants to speak posts with `propose_post` (`target`, `text`, and `by` naming the agent, not Kyle). That request is queued. The window shows it and Kyle approves or rejects it. Approval sends the `PRIVMSG` only after a nick is connected in the window. Until then the post stays pending.

## Sources

The agent-built suite is vendored at `vendor/irc-suite/`. Orbit looks there by default, or at `ORBIT_IRC_SOURCE` when that is set. The directory must contain:

- `packages/protocol`
- `packages/ircd`
- `packages/client`
- `packages/orbit-app`

Orbit launches `packages/ircd/bin/ircd.js` (the `orbit-ircd` bin). The host and port are `--host`, `--port`, `ORBIT_IRC_HOST`, `ORBIT_IRC_PORT`, `IRC_HOST`, `IRC_PORT`, `IRCD_HOST`, and `IRCD_PORT`. The entry has to stay inside the source directory.

`npm test` runs the Orbit tests and then the suite (`npm run test:irc`, which is `npm test` inside `vendor/irc-suite`). If those packages are missing, Start reports that the sources are not installed and does not launch a process. The Orbit window is the client. `packages/orbit-app` stays in the suite and is covered by its own tests; it is not a second Orbit window.
