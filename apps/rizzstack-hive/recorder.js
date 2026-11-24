import { trace, traceFrame, chapters } from "./trace.js";

export function createRecorder(root, { onFrame }) {
  const doc = root.ownerDocument,
    node = (tag, cls, text) => {
      const n = doc.createElement(tag);
      n.className = cls;
      if (text) n.textContent = text;
      return n;
    };
  const box = node("section", "recorder");
  box.hidden = true;
  box.setAttribute("aria-label", "Recorded incident timeline");
  const bar = node("div", "rail-bar"),
    range = node("input", ""),
    out = node("output", ""),
    locator = node("span", "event-locator"),
    list = node("div", "chapter-list");
  range.type = "range";
  range.min = 0;
  range.max = String(trace.events.length - 1);
  range.setAttribute("aria-label", "Recorded event position");
  let timer = 0,
    pos = 0;
  function button(name, cls, action) {
    const b = node("button", cls, name);
    b.onclick = action;
    b.type = "button";
    return b;
  }
  function stop() {
    clearInterval(timer);
    timer = 0;
    play.textContent = "Play recording";
    play.setAttribute("aria-pressed", "false");
  }
  function seek(i, automatic = false) {
    if (box.hidden) return;
    if (!automatic) stop();
    pos = Math.max(0, Math.min(trace.events.length - 1, i));
    const e = trace.events[pos],
      v = traceFrame(pos);
    range.value = String(pos);
    out.textContent = `${String(pos + 1).padStart(2, "0")} / ${trace.events.length} · ${e.time.slice(11, 19)} UTC`;
    locator.textContent = e.lane + " / " + e.title;
    [...list.children].forEach((b, k) => {
      if (pos === chapters[k].i) b.setAttribute("aria-current", "step");
      else b.removeAttribute("aria-current");
    });
    onFrame(v, e);
  }
  const play = button("Play recording", "edition-btn", () => {
    if (timer) {
      stop();
      return;
    }
    if (pos === trace.events.length - 1) seek(0);
    play.textContent = "Pause recording";
    play.setAttribute("aria-pressed", "true");
    timer = setInterval(() => {
      if (doc.hidden || pos === trace.events.length - 1) {
        stop();
        return;
      }
      seek(pos + 1, true);
    }, 1600);
  });
  const prev = button("←", "edition-btn", () => seek(pos - 1)),
    next = button("→", "edition-btn", () => seek(pos + 1));
  prev.setAttribute("aria-label", "Previous recorded event");
  next.setAttribute("aria-label", "Next recorded event");
  range.oninput = () => seek(Number(range.value));
  bar.append(
    node("strong", "", "Incident recorder"),
    prev,
    range,
    next,
    out,
    play,
  );
  for (const c of chapters)
    list.append(button(c.title, "chapter", () => seek(c.i)));
  doc.addEventListener("visibilitychange", () => {
    if (doc.hidden) stop();
  });
  box.append(bar, locator, list);
  root.prepend(box);
  return {
    seek,
    stop,
    setEnabled(enabled) {
      box.hidden = !enabled;
      stop();
      if (enabled) seek(chapters[1].i);
    },
  };
}
