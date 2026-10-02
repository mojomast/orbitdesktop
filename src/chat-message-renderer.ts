type Message = { role: 'user' | 'assistant'; text: string };
const MAX_FORMATTED_LENGTH = 100000;
const MAX_BLOCKS = 400;
function node<K extends keyof HTMLElementTagNameMap>(tag: K, className = '', text?: string) {
  const result = document.createElement(tag); result.className = className;
  if (text !== undefined) result.textContent = text;
  return result;
}
function copyButton(label: string, text: string) {
  const control = node('button', 'small-button chat-copy', label);
  control.type = 'button'; control.setAttribute('aria-label', label);
  control.onclick = async () => {
    try { await navigator.clipboard.writeText(text); control.textContent = 'Copied'; }
    catch { control.textContent = 'Copy failed'; control.title = 'Clipboard unavailable. Select the text and copy manually.'; }
  };
  return control;
}
// Deliberately bounded formatting. Model output is always text, never HTML.
function appendLinks(parent: HTMLElement, text: string) {
  const pattern = /\[([^\]\n]{1,300})\]\(([^\s)]{1,2048})\)/g;
  let start = 0, count = 0;
  for (const match of text.matchAll(pattern)) {
    if (++count > 100) break;
    parent.append(document.createTextNode(text.slice(start, match.index)));
    let safe = false;
    try { safe = ['https:', 'http:', 'mailto:'].includes(new URL(match[2]).protocol); } catch {}
    if (safe) {
      const link = node('a', '', match[1]); link.href = match[2]; link.target = '_blank'; link.rel = 'noopener noreferrer'; parent.append(link);
    } else parent.append(document.createTextNode(match[0]));
    start = match.index! + match[0].length;
  }
  parent.append(document.createTextNode(text.slice(start)));
}
export function renderChatText(text: string): HTMLElement {
  const content = node('div', 'chat-rich-text');
  if (text.length > MAX_FORMATTED_LENGTH) { content.append(node('p', '', text)); return content; }
  const lines = text.split('\n'); let index = 0, blocks = 0;
  while (index < lines.length) {
    if (++blocks > MAX_BLOCKS) { content.append(node('p', '', lines.slice(index).join('\n'))); break; }
    const fence = /^\s*(`{3,}|~{3,})([^`~]*)$/.exec(lines[index]);
    if (fence) {
      index++; const codeLines: string[] = [];
      const closing = new RegExp(`^\\s*${fence[1][0]}{${fence[1].length},}\\s*$`);
      while (index < lines.length && !closing.test(lines[index])) codeLines.push(lines[index++]);
      if (index < lines.length) index++;
      const source = codeLines.join('\n'), block = node('div', 'chat-code-block'), header = node('div', 'chat-code-header');
      header.append(node('span', '', fence[2].trim().slice(0, 80) || 'Code'), copyButton('Copy code', source));
      const pre = node('pre'); pre.append(node('code', '', source)); block.append(header, pre); content.append(block);
    } else {
      const paragraph: string[] = [];
      while (index < lines.length && lines[index].trim() && !/^\s*(`{3,}|~{3,})([^`~]*)$/.test(lines[index])) paragraph.push(lines[index++]);
      if (paragraph.length) { const p = node('p'); appendLinks(p, paragraph.join('\n')); content.append(p); } else index++;
    }
  }
  return content;
}
export function createChatMessageRenderer(container: HTMLElement) {
  const latest = node('button', 'small-button chat-jump-latest', 'Jump to latest'); latest.type = 'button'; latest.hidden = true;
  let binding: string | undefined, unseen = false;
  let rows: { key: string; element: HTMLElement }[] = [];
  const nearBottom = () => container.scrollHeight - container.clientHeight - container.scrollTop <= 64;
  function updateLatest() {
    if (nearBottom()) unseen = false;
    latest.hidden = nearBottom(); latest.textContent = unseen ? 'New messages · Jump to latest' : 'Jump to latest';
  }
  latest.onclick = () => { container.scrollTop = container.scrollHeight; unseen = false; updateLatest(); };
  container.addEventListener('scroll', updateLatest);
  return {
    latest,
    render(messages: readonly Message[], nextBinding: string) {
      const reset = binding !== nextBinding, follow = reset || nearBottom(), oldTop = container.scrollTop;
      const bounds = container.getBoundingClientRect();
      const anchor = rows.find(row => row.element.getBoundingClientRect().bottom > bounds.top);
      const anchorTop = anchor?.element.getBoundingClientRect().top;
      if (reset) { container.replaceChildren(); rows = []; unseen = false; binding = nextBinding; }
      // Content/occurrence keys survive JSON snapshot replacement and history
      // trimming without requiring a new persisted message-ID contract.
      const available = new Map<string, typeof rows>();
      for (const row of rows) { const list = available.get(row.key) || []; list.push(row); available.set(row.key, list); }
      const display = messages.length ? messages : [{ role: 'assistant' as const, text: 'Hi, I’m Hermes. Connect host with your Orbit token, then send me a message. This pane has its own conversation.' }];
      let changed = false;
      const next = display.map(message => {
        const key = JSON.stringify([message.role, message.text]), existing = available.get(key)?.shift();
        if (existing) return existing;
        changed = true;
        const element = node('div', `chat-message ${message.role}`), header = node('div', 'chat-message-header');
        header.append(node('small', '', message.role === 'user' ? 'YOU' : 'HERMES'), copyButton('Copy message', message.text));
        element.append(header, renderChatText(message.text)); return { key, element };
      });
      const retained = new Set(next.map(row => row.element));
      for (const row of rows) if (!retained.has(row.element)) { row.element.remove(); changed = true; }
      next.forEach((row, index) => { if (container.children[index] !== row.element) container.insertBefore(row.element, container.children[index] || null); });
      rows = next;
      if (changed) {
        if (follow) container.scrollTop = container.scrollHeight;
        else {
          if (anchor && retained.has(anchor.element) && anchorTop !== undefined) {
            // Measuring can trigger native scroll anchoring. Apply only the
            // remaining visual delta to its current (possibly corrected) top.
            const delta = anchor.element.getBoundingClientRect().top - anchorTop;
            container.scrollTop += delta;
          }
          else container.scrollTop = oldTop;
          unseen = true;
        }
      }
      updateLatest();
    },
    dispose() { container.removeEventListener('scroll', updateLatest); },
  };
}
