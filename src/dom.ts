export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  cls = "",
  text = "",
): HTMLElementTagNameMap[K] {
  const n = document.createElement(tag);
  n.className = cls;
  n.textContent = text;
  return n;
}
export function button(
  text: string,
  title: string,
  action: () => void,
  cls = "",
) {
  const b = el("button", cls, text);
  b.type = "button";
  b.title = title;
  b.setAttribute("aria-label", title);
  b.onclick = action;
  return b;
}
export function select(
  items: [string, string][],
  value: string,
  change: (v: string) => void,
) {
  const s = el("select");
  for (const [v, label] of items) {
    const o = el("option", "", label);
    o.value = v;
    s.append(o);
  }
  s.value = value;
  s.onchange = () => change(s.value);
  return s;
}
