export type Message = { role: 'user' | 'assistant'; text: string };
export type ChatState = { session: string; profile_id?: string; binding_revision?: number; messages: Message[]; run?: string; title?: string; color?: string; queue?: string[] };

const SERVER_ID = /^[A-Za-z0-9_:-]{1,128}$/;
const PROFILE_ID = /^[A-Za-z0-9_-]{1,64}$/;
export const DEFAULT_PROFILE_ID = 'default';

export function chatProfileId(state: Pick<ChatState, 'profile_id'>): string {
  return state.profile_id ?? DEFAULT_PROFILE_ID;
}

export function chatBindingKey(state: Pick<ChatState, 'profile_id' | 'session'>): string {
  return JSON.stringify([chatProfileId(state), state.session]);
}
export function validChat(value: unknown): value is ChatState {
  if (!value || typeof value !== 'object') return false;
  const s = value as ChatState;
  return typeof s.session === 'string' && SERVER_ID.test(s.session) &&
    (s.profile_id === undefined || (typeof s.profile_id === 'string' && PROFILE_ID.test(s.profile_id))) &&
    (s.binding_revision === undefined || (Number.isSafeInteger(s.binding_revision) && s.binding_revision >= 0)) &&
    Array.isArray(s.messages) && s.messages.length <= 100 && s.messages.every(m => m && ['user', 'assistant'].includes(m.role) && typeof m.text === 'string');
}
export function archiveChat(list: ChatState[], state: ChatState): ChatState[] {
  if (!state.messages.length || state.run) return list;
  const key = chatBindingKey(state);
  return [{ ...state, run: undefined }, ...list.filter(x => chatBindingKey(x) !== key)].slice(0, 10);
}
export function transcript(state: ChatState): string {
  return `Hermes profile: ${chatProfileId(state)}\nHermes conversation: ${state.session}\n\n` + state.messages.map(m => `${m.role === 'user' ? 'YOU' : 'HERMES'}\n${m.text}`).join('\n\n');
}
