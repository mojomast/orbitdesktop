export const MCP_APPS_LIMITS = Object.freeze({ snapshots: 64, bytes: 1572864, title: 80 });
export const MCP_APPS_CAPABILITIES = Object.freeze({ logging: Object.freeze({}) });
export function validateMcpSnapshot(value) {
  const fail = message => { throw new Error(message); };
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('Expected snapshot object');
  const keys = ['title', 'resource_uri', 'html', 'arguments', 'result'];
  if (Object.keys(value).some(key => !keys.includes(key)) || keys.some(key => !(key in value))) fail('Snapshot fields must be title, resource_uri, html, arguments, result');
  if (typeof value.title !== 'string' || !value.title.trim() || value.title.length > 80) fail('Invalid title');
  if (typeof value.resource_uri !== 'string' || !/^ui:\/\/[^\s]{1,240}$/.test(value.resource_uri)) fail('Exact ui:// resource identity required');
  if (typeof value.html !== 'string' || !value.html.trim()) fail('HTML resource required');
  if (!value.arguments || typeof value.arguments !== 'object' || Array.isArray(value.arguments)) fail('Tool arguments must be an object');
  if (!value.result || typeof value.result !== 'object' || Array.isArray(value.result) || !Array.isArray(value.result.content)) fail('Tool result content array required');
  if (new TextEncoder().encode(JSON.stringify(value)).length > MCP_APPS_LIMITS.bytes) fail('Snapshot exceeds 1.5 MiB');
  return value;
}
