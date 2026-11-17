// Pure preview only. Imported by the reviewed shell; no network or authority.
const opaque = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,191}$/.test(value);
export function feedbackDraft(target, rating, category, note, previous) {
  if (!opaque(target) || ![-1,0,1,null].includes(rating) || !['quality','intervention','both'].includes(category) ||
      typeof note !== 'string' || note.length > 2000 || (previous !== null && !opaque(previous))) throw Error('Invalid draft');
  return Object.freeze({target_event_id:target,rating,category,note:note.trim()?'[redacted]':'',supersedes_event_id:previous,idempotency_key:crypto.randomUUID()});
}
