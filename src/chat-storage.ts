export type Message = { role: 'user' | 'assistant'; text: string };
export type ChatState = { session: string; messages: Message[]; run?: string; title?: string; color?: string; queue?: string[] };
export function validChat(value: unknown): value is ChatState {
  const s = value as ChatState;
  return !!s && /^orbit-[0-9a-f-]{36}$/.test(s.session) && Array.isArray(s.messages) && s.messages.length <= 100 && s.messages.every(m => m && ['user', 'assistant'].includes(m.role) && typeof m.text === 'string');
}
export function archiveChat(list: ChatState[], state: ChatState): ChatState[] {
  if (!state.messages.length || state.run) return list;
  return [{ ...state, run: undefined }, ...list.filter(x => x.session !== state.session)].slice(0, 10);
}
export function transcript(state: ChatState): string {
  return `Hermes conversation: ${state.session}\n\n` + state.messages.map(m => `${m.role === 'user' ? 'YOU' : 'HERMES'}\n${m.text}`).join('\n\n');
}
