import { parseMessages } from "../contracts/interactive-results-v1.mjs";

/** Producer-neutral adapter. Hermes is not assumed to emit this format. */
export function extractInteractiveResult(
  text: string,
):
  | { status: "ok"; messages: any[] }
  | { status: "unavailable"; reason: string } {
  if (typeof text !== "string" || new TextEncoder().encode(text).length > 65536)
    return {
      status: "unavailable",
      reason: "Result text exceeds 65,536 bytes.",
    };
  const blocks = [...text.matchAll(/```a2ui\s*\n([\s\S]*?)\n```/g)];
  if (blocks.length > 1)
    return {
      status: "unavailable",
      reason: "Expected exactly one a2ui envelope.",
    };
  let payload = blocks[0]?.[1];
  if (!payload) {
    try {
      const object = JSON.parse(text);
      if (Object.keys(object).length === 1 && Object.hasOwn(object, "a2ui"))
        payload = JSON.stringify(object.a2ui);
    } catch {}
  }
  if (!payload)
    return {
      status: "unavailable",
      reason: "No explicit a2ui JSON envelope in this result.",
    };
  try {
    return { status: "ok", messages: parseMessages(payload) };
  } catch (error) {
    return { status: "unavailable", reason: (error as Error).message };
  }
}
