import { createHash } from "node:crypto";
export const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
export const EXTRACTOR = "utf8-plain-v1";
export function decode(bytes) {
  const text = new TextDecoder("utf-8", {
    fatal: true,
    ignoreBOM: true,
  }).decode(bytes);
  if (/\u0000/.test(text))
    throw Object.assign(Error("unsupported"), { code: "unsupported" });
  return text;
}
// UTF-16 offsets are exact JavaScript slice offsets, never token positions.
export function chunk(text) {
  const result = [];
  for (let start = 0; start < text.length; ) {
    let end = Math.min(start + 1200, text.length);
    if (end < text.length && /[\uD800-\uDBFF]/.test(text[end - 1])) end--;
    result.push({ start, end, text: text.slice(start, end) });
    start = end;
  }
  return result;
}
