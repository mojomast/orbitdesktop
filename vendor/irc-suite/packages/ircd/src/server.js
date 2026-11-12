// RFC 1459/2812 subset ircd.
import net from 'node:net';
import { parseMessage, serializeMessage, splitLines, ircLower, isValidNick, isChannelName, RPL, ERR } from '../../protocol/src/index.js';

export function createServer({ port = 6667, host = '127.0.0.1', name = 'orbit.irc' } = {}) {
  const clients = new Set();
  const nicks = new Map();
  const channels = new Map();
  const created = new Date().toUTCString();
  const tcp = net.createServer(onConnection);

  const mask = (c) => c.nick + '!' + (c.user || '*') + '@' + c.host;
  function send(c, msg) { if (!c.sock.destroyed) c.sock.write(serializeMessage(msg)); }
  function numeric(c, code, ...params) { send(c, { prefix: name, command: code, params: [c.nick || '*', ...params] }); }
  function toChannel(ch, msg, except) { for (const m of ch.members) if (m !== except) send(m, msg); }
  function peers(c) { const s = new Set(); for (const ch of c.channels) for (const m of ch.members) if (m !== c) s.add(m); return s; }

  function onConnection(sock) {
    sock.setEncoding('utf8');
    const c = { sock, nick: null, user: null, realname: '', host: sock.remoteAddress || 'unknown', registered: false, channels: new Set(), buf: '', modes: new Set() };
    clients.add(c);
    sock.on('data', (d) => {
      c.buf += d;
      if (c.buf.length > 65536) return quit(c, 'Excess flood');
      const { lines, rest } = splitLines(c.buf);
      c.buf = rest;
      for (const line of lines) {
        if (sock.destroyed || !clients.has(c)) return;
        const msg = parseMessage(line);
        if (msg) { try { handle(c, msg); } catch (e) { /* keep serving */ } }
      }
    });
    sock.on('error', () => {});
    sock.on('close', () => quit(c, 'Connection closed'));
  }

  function tryRegister(c) {
    if (c.registered || !c.nick || !c.user) return;
    c.registered = true;
    numeric(c, RPL.WELCOME, 'Welcome to the Orbit IRC Network ' + mask(c));
    numeric(c, RPL.YOURHOST, 'Your host is ' + name + ', running orbit-ircd-0.1');
    numeric(c, RPL.CREATED, 'This server was created ' + created);
    numeric(c, RPL.MYINFO, name, 'orbit-ircd-0.1', 'i', 'ntoi');
    numeric(c, ERR.NOMOTD, 'MOTD File is missing');
  }

  function leave(ch, c) {
    ch.members.delete(c); ch.ops.delete(c); c.channels.delete(ch);
    if (ch.members.size === 0) channels.delete(ircLower(ch.name));
  }

  function quit(c, reason) {
    if (!clients.has(c)) return;
    clients.delete(c);
    if (c.registered) { const msg = { prefix: mask(c), command: 'QUIT', params: [reason] }; for (const p of peers(c)) send(p, msg); }
    for (const ch of [...c.channels]) leave(ch, c);
    if (c.nick && nicks.get(ircLower(c.nick)) === c) nicks.delete(ircLower(c.nick));
    if (!c.sock.destroyed) { c.sock.end(); setTimeout(() => c.sock.destroy(), 100).unref(); }
  }

  function sendNames(c, ch) {
    const names = [...ch.members].map((m) => (ch.ops.has(m) ? '@' : '') + m.nick);
    for (let i = 0; i < names.length; i += 40) numeric(c, RPL.NAMREPLY, '=', ch.name, names.slice(i, i + 40).join(' '));
    numeric(c, RPL.ENDOFNAMES, ch.name, 'End of /NAMES list');
  }

  function message(c, cmd, target, text) {
    const notice = cmd === 'NOTICE';
    if (!target) { if (!notice) numeric(c, ERR.NORECIPIENT, 'No recipient given (' + cmd + ')'); return; }
    if (text === undefined || text === '') { if (!notice) numeric(c, ERR.NOTEXTTOSEND, 'No text to send'); return; }
    for (const t of target.split(',')) {
      if (isChannelName(t)) {
        const ch = channels.get(ircLower(t));
        if (!ch) { if (!notice) numeric(c, ERR.NOSUCHNICK, t, 'No such nick/channel'); continue; }
        if (ch.modes.has('n') && !ch.members.has(c)) { if (!notice) numeric(c, ERR.CANNOTSENDTOCHAN, ch.name, 'Cannot send to channel'); continue; }
        toChannel(ch, { prefix: mask(c), command: cmd, params: [ch.name, text] }, c);
      } else {
        const u = nicks.get(ircLower(t));
        if (!u || !u.registered) { if (!notice) numeric(c, ERR.NOSUCHNICK, t, 'No such nick/channel'); continue; }
        send(u, { prefix: mask(c), command: cmd, params: [u.nick, text] });
      }
    }
  }

  function channelMode(c, target, modestr, args) {
    const ch = channels.get(ircLower(target));
    if (!ch) return numeric(c, ERR.NOSUCHCHANNEL, target, 'No such channel');
    if (!modestr) return numeric(c, RPL.CHANNELMODEIS, ch.name, '+' + [...ch.modes].sort().join(''));
    if (!ch.ops.has(c)) return numeric(c, ERR.CHANOPRIVSNEEDED, ch.name, 'You are not channel operator');
    let add = true; let out = ''; let last = ''; const outArgs = [];
    const emit = (f) => { const s = add ? '+' : '-'; if (s !== last) { out += s; last = s; } out += f; };
    for (const f of modestr) {
      if (f === '+' || f === '-') { add = f === '+'; continue; }
      if (f === 'o') {
        const nick = args.shift();
        if (!nick) { numeric(c, ERR.NEEDMOREPARAMS, 'MODE', 'Not enough parameters'); continue; }
        const u = nicks.get(ircLower(nick));
        if (!u) { numeric(c, ERR.NOSUCHNICK, nick, 'No such nick/channel'); continue; }
        if (!ch.members.has(u)) { numeric(c, ERR.USERNOTINCHANNEL, u.nick, ch.name, 'They are not on that channel'); continue; }
        if (add) ch.ops.add(u); else ch.ops.delete(u);
        emit('o'); outArgs.push(u.nick);
      } else if (f === 't' || f === 'n') {
        if (add) ch.modes.add(f); else ch.modes.delete(f);
        emit(f);
      } else numeric(c, ERR.UNKNOWNMODE, f, 'is unknown mode char to me');
    }
    if (out) toChannel(ch, { prefix: mask(c), command: 'MODE', params: [ch.name, out, ...outArgs] });
  }

  const handlers = {
    NICK(c, [nick]) {
      if (!nick) return numeric(c, ERR.NONICKNAMEGIVEN, 'No nickname given');
      if (!isValidNick(nick)) return numeric(c, ERR.ERRONEUSNICKNAME, nick, 'Erroneous nickname');
      const owner = nicks.get(ircLower(nick));
      if (owner && owner !== c) return numeric(c, ERR.NICKNAMEINUSE, nick, 'Nickname is already in use');
      if (c.nick) nicks.delete(ircLower(c.nick));
      if (c.registered) { const msg = { prefix: mask(c), command: 'NICK', params: [nick] }; send(c, msg); for (const p of peers(c)) send(p, msg); }
      c.nick = nick; nicks.set(ircLower(nick), c);
      tryRegister(c);
    },
    USER(c, p) {
      if (c.registered) return numeric(c, ERR.ALREADYREGISTRED, 'You may not reregister');
      if (p.length < 4) return numeric(c, ERR.NEEDMOREPARAMS, 'USER', 'Not enough parameters');
      c.user = p[0]; c.realname = p[3];
      tryRegister(c);
    },
    PING(c, [tok]) {
      if (tok === undefined) return numeric(c, ERR.NEEDMOREPARAMS, 'PING', 'Not enough parameters');
      send(c, { prefix: name, command: 'PONG', params: [name, tok] });
    },
    PONG() {},
    QUIT(c, [reason]) { quit(c, reason ? 'Quit: ' + reason : 'Client Quit'); },
    JOIN(c, [targets]) {
      if (!targets) return numeric(c, ERR.NEEDMOREPARAMS, 'JOIN', 'Not enough parameters');
      if (targets === '0') { for (const ch of [...c.channels]) handlers.PART(c, [ch.name]); return; }
      for (const chName of targets.split(',')) {
        if (!isChannelName(chName)) { numeric(c, ERR.NOSUCHCHANNEL, chName, 'No such channel'); continue; }
        let ch = channels.get(ircLower(chName));
        if (ch && ch.members.has(c)) continue;
        if (!ch) { ch = { name: chName, topic: '', members: new Set(), ops: new Set(), modes: new Set(['n', 't']) }; channels.set(ircLower(chName), ch); ch.ops.add(c); }
        ch.members.add(c); c.channels.add(ch);
        toChannel(ch, { prefix: mask(c), command: 'JOIN', params: [ch.name] });
        if (ch.topic) numeric(c, RPL.TOPIC, ch.name, ch.topic);
        sendNames(c, ch);
      }
    },
    PART(c, [targets, reason]) {
      if (!targets) return numeric(c, ERR.NEEDMOREPARAMS, 'PART', 'Not enough parameters');
      for (const chName of targets.split(',')) {
        const ch = channels.get(ircLower(chName));
        if (!ch) { numeric(c, ERR.NOSUCHCHANNEL, chName, 'No such channel'); continue; }
        if (!ch.members.has(c)) { numeric(c, ERR.NOTONCHANNEL, ch.name, 'You are not on that channel'); continue; }
        toChannel(ch, { prefix: mask(c), command: 'PART', params: reason ? [ch.name, reason] : [ch.name] });
        leave(ch, c);
      }
    },
    PRIVMSG(c, [t, x]) { message(c, 'PRIVMSG', t, x); },
    NOTICE(c, [t, x]) { message(c, 'NOTICE', t, x); },
    TOPIC(c, [chName, text]) {
      if (!chName) return numeric(c, ERR.NEEDMOREPARAMS, 'TOPIC', 'Not enough parameters');
      const ch = channels.get(ircLower(chName));
      if (!ch) return numeric(c, ERR.NOSUCHCHANNEL, chName, 'No such channel');
      if (!ch.members.has(c)) return numeric(c, ERR.NOTONCHANNEL, ch.name, 'You are not on that channel');
      if (text === undefined) return ch.topic ? numeric(c, RPL.TOPIC, ch.name, ch.topic) : numeric(c, RPL.NOTOPIC, ch.name, 'No topic is set');
      if (ch.modes.has('t') && !ch.ops.has(c)) return numeric(c, ERR.CHANOPRIVSNEEDED, ch.name, 'You are not channel operator');
      ch.topic = text;
      toChannel(ch, { prefix: mask(c), command: 'TOPIC', params: [ch.name, text] });
    },
    NAMES(c, [targets]) {
      if (!targets) { for (const ch of c.channels) sendNames(c, ch); return; }
      for (const chName of targets.split(',')) {
        const ch = channels.get(ircLower(chName));
        if (ch) sendNames(c, ch); else numeric(c, RPL.ENDOFNAMES, chName, 'End of /NAMES list');
      }
    },
    WHO(c, [m]) {
      const ch = m ? channels.get(ircLower(m)) : null;
      const reply = (u, chan) => numeric(c, RPL.WHOREPLY, chan ? chan.name : '*', u.user || '*', u.host, name, u.nick, 'H' + (chan && chan.ops.has(u) ? '@' : ''), '0 ' + u.realname);
      if (ch) { for (const u of ch.members) reply(u, ch); }
      else if (m) { const u = nicks.get(ircLower(m)); if (u && u.registered) reply(u, [...u.channels][0]); }
      numeric(c, RPL.ENDOFWHO, m || '*', 'End of /WHO list');
    },
    MODE(c, [target, modestr, ...args]) {
      if (!target) return numeric(c, ERR.NEEDMOREPARAMS, 'MODE', 'Not enough parameters');
      if (isChannelName(target)) return channelMode(c, target, modestr, args);
      const u = nicks.get(ircLower(target));
      if (!u) return numeric(c, ERR.NOSUCHNICK, target, 'No such nick/channel');
      if (u !== c) return numeric(c, ERR.USERSDONTMATCH, 'Cannot change mode for other users');
      if (!modestr) return numeric(c, RPL.UMODEIS, '+' + [...c.modes].join(''));
      let add = true; let out = '';
      for (const f of modestr) {
        if (f === '+' || f === '-') { add = f === '+'; continue; }
        if (f !== 'i') { numeric(c, ERR.UMODEUNKNOWNFLAG, 'Unknown MODE flag'); continue; }
        if (add !== c.modes.has(f)) { if (add) c.modes.add(f); else c.modes.delete(f); out += (add ? '+' : '-') + f; }
      }
      if (out) send(c, { prefix: mask(c), command: 'MODE', params: [c.nick, out] });
    },
  };

  const preReg = new Set(['NICK', 'USER', 'PING', 'PONG', 'QUIT']);
  function handle(c, msg) {
    if (msg.command === 'CAP') return;
    if (!c.registered && !preReg.has(msg.command)) return numeric(c, ERR.NOTREGISTERED, 'You have not registered');
    const h = handlers[msg.command];
    if (!h) return numeric(c, ERR.UNKNOWNCOMMAND, msg.command, 'Unknown command');
    h(c, msg.params);
  }

  return {
    listen() { return new Promise((res, rej) => { tcp.once('error', rej); tcp.listen(port, host, () => { tcp.off('error', rej); res(this); }); }); },
    close() {
      for (const c of clients) c.sock.destroy();
      clients.clear(); nicks.clear(); channels.clear();
      return new Promise((res) => tcp.close(() => res()));
    },
    address() { return tcp.address(); },
    get clientCount() { return clients.size; },
    get channelCount() { return channels.size; },
  };
}
