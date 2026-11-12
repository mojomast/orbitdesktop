#!/usr/bin/env node
// packages/client/src/cli.js
// readline-based IRC CLI on top of the IrcClient library.
import readline from 'node:readline';
import { pathToFileURL } from 'node:url';
import { IrcClient, DEFAULT_HOST, DEFAULT_PORT } from './index.js';

export const HELP = [
  'commands:',
  '  /join <#chan> [key]   join a channel (plain text then goes there)',
  '  /part [#chan] [msg]   leave a channel',
  '  /msg <target> <text>  send a private message',
  '  /me <text>            send an ACTION to the current channel',
  '  /notice <target> <text> send a NOTICE',
  '  /topic [#chan] [text] read or set the topic',
  '  /names [#chan]        list members',
  '  /who [mask]           WHO query',
  '  /mode <target> [modes] query or set modes',
  '  /nick <nick>          change nickname',
  '  /quit [msg]           disconnect',
  '  /help                 this text',
].join('\n');

/**
 * Split one line of CLI input into a command or plain text.
 * Returns { type: 'empty' } | { type: 'text', text } | { type: 'command', command, args, text }.
 */
export function parseCommandLine(input) {
  const line = String(input ?? '').replace(/[\r\n]+$/, '');
  const trimmed = line.trim();
  if (!trimmed) return { type: 'empty' };
  if (!trimmed.startsWith('/')) return { type: 'text', text: trimmed };
  const body = trimmed.slice(1);
  const space = body.search(/\s/);
  const command = (space === -1 ? body : body.slice(0, space)).toUpperCase();
  const rest = space === -1 ? '' : body.slice(space + 1).trim();
  const args = rest ? rest.split(/\s+/) : [];
  return { type: 'command', command, args, text: rest };
}

/**
 * Run one line of input against a client-like object.
 * `state.currentChannel` is remembered across calls. Returns a description of
 * what was done, which is what the tests assert on.
 */
export function dispatch(client, state, input) {
  const parsed = parseCommandLine(input);
  if (parsed.type === 'empty') return { action: 'none' };
  if (parsed.type === 'text') {
    if (!state.currentChannel) return { action: 'no-channel', text: parsed.text };
    client.say(state.currentChannel, parsed.text);
    return { action: 'say', target: state.currentChannel, text: parsed.text };
  }

  const { command, args } = parsed;
  const join = (from, sep = ' ') => args.slice(from).join(sep);

  switch (command) {
    case 'JOIN': {
      const channel = args[0];
      if (!channel) return { action: 'usage', command };
      client.join(channel, args[1]);
      state.currentChannel = channel;
      return { action: 'join', channel };
    }
    case 'PART': {
      const channel = args[0] && args[0].startsWith('#') ? args[0] : state.currentChannel;
      if (!channel) return { action: 'usage', command };
      const message = args[0] && args[0].startsWith('#') ? join(1) : join(0);
      client.part(channel, message || undefined);
      if (state.currentChannel && state.currentChannel.toLowerCase() === channel.toLowerCase()) state.currentChannel = null;
      return { action: 'part', channel, text: message || undefined };
    }
    case 'MSG': {
      const [to, ...rest] = args;
      if (!to || !rest.length) return { action: 'usage', command };
      const text = rest.join(' ');
      client.say(to, text);
      return { action: 'say', target: to, text };
    }
    case 'NOTICE': {
      const [to, ...rest] = args;
      if (!to || !rest.length) return { action: 'usage', command };
      const text = rest.join(' ');
      client.notice(to, text);
      return { action: 'notice', target: to, text };
    }
    case 'ME': {
      if (!state.currentChannel) return { action: 'no-channel' };
      const text = join(0);
      if (!text) return { action: 'usage', command };
      client.action(state.currentChannel, text);
      return { action: 'action', target: state.currentChannel, text };
    }
    case 'TOPIC': {
      const explicit = args[0] && args[0].startsWith('#') ? args[0] : null;
      const channel = explicit ?? state.currentChannel;
      if (!channel) return { action: 'usage', command };
      const text = (explicit ? join(1) : join(0)) || undefined;
      client.topic(channel, text);
      return { action: 'topic', channel, text };
    }
    case 'NAMES': {
      const channel = args[0] && args[0].startsWith('#') ? args[0] : state.currentChannel;
      if (!channel) return { action: 'usage', command };
      client.names(channel);
      return { action: 'names', channel };
    }
    case 'WHO': {
      const mask = args[0] ?? state.currentChannel ?? '*';
      client.who(mask);
      return { action: 'who', mask };
    }
    case 'MODE': {
      const [target, ...modes] = args;
      if (!target) return { action: 'usage', command };
      client.mode(target, modes.length ? modes.join(' ') : undefined);
      return { action: 'mode', target, modes: modes.join(' ') };
    }
    case 'NICK': {
      if (!args[0]) return { action: 'usage', command };
      client.setNick(args[0]);
      return { action: 'nick', nick: args[0] };
    }
    case 'QUIT': {
      client.quit(join(0) || undefined);
      return { action: 'quit', text: join(0) || undefined };
    }
    case 'HELP':
      return { action: 'help', text: HELP };
    default:
      return { action: 'unknown', command };
  }
}

/** Parse CLI flags into client options. */
export function parseArgs(argv) {
  const opts = { host: DEFAULT_HOST, port: DEFAULT_PORT, nick: null, realname: null, user: null, channel: null, help: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = () => argv[++i];
    switch (arg) {
      case '--host': case '-h': opts.host = next(); break;
      case '--port': case '-p': opts.port = Number(next()); break;
      case '--nick': case '-n': opts.nick = next(); break;
      case '--user': opts.user = next(); break;
      case '--realname': case '-r': opts.realname = next(); break;
      case '--channel': case '-c': opts.channel = next(); break;
      case '--help': opts.help = true; break;
      default: break;
    }
  }
  return opts;
}

export function main(argv = process.argv.slice(2)) {
  const opts = parseArgs(argv);
  if (opts.help || !opts.nick) {
    process.stdout.write(`usage: orbit-irc --nick <nick> [--host ${DEFAULT_HOST}] [--port ${DEFAULT_PORT}] [--channel '#chan']\n\n${HELP}\n`);
    return opts.help ? 0 : 1;
  }

  const client = new IrcClient({ host: opts.host, port: opts.port, nick: opts.nick, user: opts.user, realname: opts.realname });
  const state = { currentChannel: opts.channel };
  const print = (line) => process.stdout.write(`${line}\n`);

  client.on('registered', ({ nick }) => {
    print(`connected as ${nick}`);
    if (state.currentChannel) client.join(state.currentChannel);
  });
  client.on('message', ({ nick, target, text, isAction }) => print(isAction ? `* ${nick} ${text}` : `<${nick}> ${text}`));
  client.on('notice', ({ nick, target, text }) => print(`-${nick ?? 'server'}- ${text}`));
  client.on('join', ({ nick, channel, self }) => print(`* ${nick} joined ${channel}${self ? ' (you)' : ''}`));
  client.on('part', ({ nick, channel, text }) => print(`* ${nick} left ${channel}${text ? ` (${text})` : ''}`));
  client.on('quit', ({ nick, text }) => print(`* ${nick} quit${text ? ` (${text})` : ''}`));
  client.on('nick', ({ oldNick, nick }) => print(`* ${oldNick} is now ${nick}`));
  client.on('topic', ({ channel, text }) => print(`* topic for ${channel}: ${text ?? '(none)'}`));
  client.on('names', ({ channel, users }) => print(`* ${users.length} users in ${channel}: ${users.map((u) => u.prefix + u.nick).join(' ')}`));
  client.on('error', (err) => print(`! ${err.code ? `${err.code} ${err.text}` : err.message ?? err}`));
  client.on('close', () => {
    print('disconnected');
    process.exit(0);
  });

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout, prompt: '> ' });
  rl.on('line', (line) => {
    try {
      dispatch(client, state, line);
    } catch (err) {
      print(`! ${err.message}`);
    }
    rl.prompt();
  });
  rl.on('close', () => client.quit('bye'));
  client.connect();
  rl.prompt();
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exit(main());
}
