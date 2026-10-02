export type ConversationScope = {workspace_id: string; profile_id: string; session_id: string};
export type PrivateConversation = ConversationScope & {revision: number; draft: string; title: string; pinned: boolean; archived: boolean};
export async function conversationRequest(getToken: () => string, body: Record<string, unknown>, keepalive = false) {
  const token = getToken();
  if (!token) throw Error('Connect host to access saved conversations and drafts.');
  const response = await fetch('/api/agent', {method:'POST',headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json'},body:JSON.stringify(body),keepalive,signal:AbortSignal.timeout(30000)});
  const data = await response.json();
  if (getToken() !== token) throw Error('Host connection changed.');
  if (!response.ok && !(response.status === 409 && data.conflict === true)) throw Error(data.error || `Conversation request failed (${response.status}).`);
  return data;
}
