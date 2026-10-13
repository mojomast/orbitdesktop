// The websocket bridge: one websocket session == one IRC client session against
// the ircd. IRC events go out as JSON, JSON commands come back in.
import { IrcClient } from '../../client/src/index.js';
import {
  RELAYED_EVENTS, STATE_EVENTS, translateEvent, translateCommand, applyCommand, stateSnapshot,
} from './translate.js';

export const defaultClientFactory = (options) => new IrcClient(options);

/**
 * Attach one websocket connection to the ircd.
 * `conn` is anything with sendJson/close, as made by createServerConnection in ws.js.
 */
export function createSession({
  conn,
  ircd = {},
  nick = 'orbit-web',
  channel = null,
  clientFactory = defaultClientFactory,
  log = () => {},
} = {}) {
  const state = { currentChannel: channel };
  const client = clientFactory({
    host: ircd.host,
    port: ircd.port,
    nick: ircd.nick ?? nick,
    user: ircd.user,
    realname: ircd.realname ?? 'Orbit web client',
  });

  const send = (message) => {
    try {
      conn.sendJson(message);
    } catch (err) {
      log('send failed', err);
    }
  };

  for (const event of RELAYED_EVENTS) {
    client.on(event, (payload) => {
      // Keep the session's notion of the current channel in step with the server.
      if ((event === 'join' || event === 'part') && payload?.channel && (payload.self || payload.nick === client.nick)) {
        if (event === 'join') state.currentChannel = payload.channel;
        else if (state.currentChannel === payload.channel) state.currentChannel = null;
      }
      send(translateEvent(event, payload));
      if (STATE_EVENTS.includes(event)) send(stateSnapshot(client, state.currentChannel));
    });
  }

  client.on('error', (err) => {
    log('irc error', err);
  });

  conn.onText?.((text) => handleCommand(text));

  function handleCommand(text) {
    const command = translateCommand(text);
    if (command.error) {
      send({ type: 'error', error: command.error });
      return command;
    }
    try {
      const effect = applyCommand(client, command, state);
      log('command', effect);
      send({ type: 'ack', ...effect });
      if (command.cmd === 'join' || command.cmd === 'part') send(stateSnapshot(client, state.currentChannel));
      return effect;
    } catch (err) {
      send({ type: 'error', error: err.message });
      return { error: err.message };
    }
  }

  conn.onClose?.(() => {
    try {
      client.quit('bridge closed');
    } catch {
      client.close?.();
    }
  });

  client.connect();

  return {
    client,
    state,
    handleCommand,
    get currentChannel() {
      return state.currentChannel;
    },
    dispatch(text) {
      return handleCommand(text);
    },
    close() {
      try {
        client.quit('bridge closed');
      } catch {
        client.close?.();
      }
    },
  };
}
