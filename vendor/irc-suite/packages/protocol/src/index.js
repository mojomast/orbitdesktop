// Shared IRC protocol helpers (RFC 1459 / 2812, with IRCv3 tag parsing).
export const MAX_LINE_BYTES = 512; // including CRLF

const TAG_UNESCAPE = { ':': ';', s: ' ', '\\': '\\', r: '\r', n: '\n' };
function unescapeTag(v) {
  return v.replace(/\\(.?)/g, (_, c) => (c in TAG_UNESCAPE ? TAG_UNESCAPE[c] : c));
}
function escapeTag(v) {
  return String(v).replace(/\\/g, '\\\\').replace(/;/g, '\\:').replace(/ /g, '\\s').replace(/\r/g, '\\r').replace(/\n/g, '\\n');
}

/** Parse one IRC line (with or without CRLF). Returns null for empty lines. */
export function parseMessage(line) {
  let s = String(line).replace(/\r?\n$/, '').replace(/\r$/, '');
  let i = 0;
  const skip = () => { while (s[i] === ' ') i++; };
  skip();
  if (i >= s.length) return null;
  const tags = {};
  if (s[i] === '@') {
    const end = s.indexOf(' ', i);
    const raw = s.slice(i + 1, end === -1 ? s.length : end);
    for (const part of raw.split(';')) {
      if (!part) continue;
      const eq = part.indexOf('=');
      if (eq === -1) tags[part] = true;
      else tags[part.slice(0, eq)] = unescapeTag(part.slice(eq + 1));
    }
    i = end === -1 ? s.length : end;
    skip();
  }
  let prefix = null;
  if (s[i] === ':') {
    const end = s.indexOf(' ', i);
    prefix = s.slice(i + 1, end === -1 ? s.length : end);
    i = end === -1 ? s.length : end;
    skip();
  }
  let end = s.indexOf(' ', i);
  const command = s.slice(i, end === -1 ? s.length : end).toUpperCase();
  if (!command) return null;
  i = end === -1 ? s.length : end;
  const params = [];
  while (i < s.length) {
    skip();
    if (i >= s.length) break;
    if (s[i] === ':') { params.push(s.slice(i + 1)); break; }
    end = s.indexOf(' ', i);
    params.push(s.slice(i, end === -1 ? s.length : end));
    i = end === -1 ? s.length : end;
  }
  return { tags, prefix, command, params };
}

/** Serialize {tags?, prefix?, command, params?} to a CRLF-terminated line, truncated to 512 bytes. */
export function serializeMessage(msg) {
  const { tags = {}, prefix = null, command, params = [] } = msg;
  if (!command) throw new Error('command required');
  let out = '';
  const tagKeys = Object.keys(tags || {});
  if (tagKeys.length) {
    out += '@' + tagKeys.map((k) => (tags[k] === true || tags[k] === '' ? k : `${k}=${escapeTag(tags[k])}`)).join(';') + ' ';
  }
  if (prefix) out += ':' + prefix + ' ';
  out += String(command).toUpperCase();
  params.forEach((p, idx) => {
    const v = String(p).replace(/[\r\n\0]/g, '');
    const last = idx === params.length - 1;
    if (last && (v === '' || v.includes(' ') || v.startsWith(':'))) out += ' :' + v;
    else {
      if (v === '' || v.includes(' ') || v.startsWith(':')) throw new Error('only the last param may contain spaces or start with :');
      out += ' ' + v;
    }
  });
  return truncateBytes(out, MAX_LINE_BYTES - 2) + '\r\n';
}

function truncateBytes(str, max) {
  const buf = Buffer.from(str, 'utf8');
  if (buf.length <= max) return str;
  let cut = max;
  while (cut > 0 && (buf[cut] & 0xc0) === 0x80) cut--; // don't split a UTF-8 char
  return buf.subarray(0, cut).toString('utf8');
}

/** Split a buffered stream into complete lines; returns {lines, rest}. */
export function splitLines(buffer) {
  const parts = buffer.split(/\r?\n/);
  const rest = parts.pop();
  return { lines: parts.filter((l) => l.length), rest };
}

/** RFC 1459 casemapping: A-Z[]\\~ lower to a-z{}|^ */
export function ircLower(s) {
  return String(s).replace(/[A-Z\[\]\\~]/g, (c) => ({ '[': '{', ']': '}', '\\': '|', '~': '^' }[c] || c.toLowerCase()));
}
export function ircEquals(a, b) { return ircLower(a) === ircLower(b); }

export function parsePrefix(prefix) {
  if (!prefix) return { nick: null, user: null, host: null };
  const m = /^([^!@]+)(?:!([^@]+))?(?:@(.+))?$/.exec(prefix);
  return m ? { nick: m[1], user: m[2] || null, host: m[3] || null } : { nick: prefix, user: null, host: null };
}

export const isChannelName = (s) => /^[#&+!][^\s,\x07]{1,49}$/.test(String(s));
export const isValidNick = (s) => /^[A-Za-z\[\]\\`_^{|}][A-Za-z0-9\[\]\\`_^{|}-]{0,29}$/.test(String(s));

export const RPL = {
  WELCOME: '001', YOURHOST: '002', CREATED: '003', MYINFO: '004',
  UMODEIS: '221', ENDOFWHO: '315', CHANNELMODEIS: '324', NOTOPIC: '331', TOPIC: '332',
  WHOREPLY: '352', NAMREPLY: '353', ENDOFNAMES: '366', MOTD: '372', MOTDSTART: '375', ENDOFMOTD: '376',
};
export const ERR = {
  NOSUCHNICK: '401', NOSUCHCHANNEL: '403', CANNOTSENDTOCHAN: '404', NORECIPIENT: '411', NOTEXTTOSEND: '412',
  UNKNOWNCOMMAND: '421', NOMOTD: '422', NONICKNAMEGIVEN: '431', ERRONEUSNICKNAME: '432', NICKNAMEINUSE: '433',
  USERNOTINCHANNEL: '441', NOTONCHANNEL: '442', NOTREGISTERED: '451', NEEDMOREPARAMS: '461', ALREADYREGISTRED: '462',
  UNKNOWNMODE: '472', CHANOPRIVSNEEDED: '482', USERSDONTMATCH: '502', UMODEUNKNOWNFLAG: '501',
};
