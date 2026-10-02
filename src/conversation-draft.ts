import { conversationRequest, type ConversationScope, type PrivateConversation } from './conversation-client';

type Cache = {text:string; revision?:number; base?:string; dirty:boolean};
type Entry = {scope:ConversationScope; key:string; cache:Cache; ready:boolean; saving:boolean; conflict?:PrivateConversation; timer?:ReturnType<typeof setTimeout>};
export function createConversationDraft(options: {
  // Host identity is shared; local recovery belongs to one stable pane.
  cacheNamespace: string;
  token: () => string;
  value: () => string;
  restore: (text:string) => void;
  status: (text:string, conflict?:{local:string; remote:string; useRemote:()=>void; keepLocal:()=>void}) => void;
}) {
  let active: Entry | undefined, closed = false;
  const entries = new Map<string, Entry>();
  const clearTimer = (entry:Entry) => { clearTimeout(entry.timer); entry.timer=undefined; };
  const cache = (entry:Entry) => { if(closed)return; try { sessionStorage.setItem(entry.key,JSON.stringify(entry.cache)); } catch {} };
  const notify = (entry:Entry, text:string) => {
    if (closed || entry !== active) return;
    const remote = entry.conflict;
    options.status(text,remote ? {local:entry.cache.text,remote:remote.draft,
      useRemote:() => { if (closed || active !== entry) return; clearTimer(entry); entry.cache={text:remote.draft,base:remote.draft,revision:remote.revision,dirty:false}; entry.conflict=undefined; cache(entry); options.restore(remote.draft); notify(entry,'Server draft restored.'); },
      keepLocal:() => { if (closed || active !== entry) return; entry.cache.revision=remote.revision; entry.cache.base=remote.draft; entry.cache.dirty=true; entry.conflict=undefined; cache(entry); void save(entry); },
    } : undefined);
  };
  async function load(entry:Entry) {
    if (closed || entry.ready || entry.saving || !options.token()) return;
    entry.saving=true;
    try {
      const {record} = await conversationRequest(options.token,{action:'draft_read',...entry.scope});
      if(closed)return;
      entry.ready=true;
      if (entry.cache.dirty) {
        if (entry.cache.text === record.draft) entry.cache={text:record.draft,base:record.draft,revision:record.revision,dirty:false};
        else if ((entry.cache.base ?? '') !== record.draft) entry.conflict=record;
        else { entry.cache.revision=record.revision; entry.cache.base=record.draft; }
      } else {
        entry.cache={text:record.draft,base:record.draft,revision:record.revision,dirty:false};
        if (entry === active && !closed) options.restore(record.draft);
      }
      cache(entry); notify(entry,entry.conflict ? 'Draft conflict: both copies are preserved. Choose which version to keep.' : 'Draft saved on host.');
    } catch { notify(entry,'Draft cached in this tab. Host save unavailable; reconnect to retry.'); }
    finally { entry.saving=false; if (!closed && entry.ready && entry.cache.dirty && !entry.conflict) void save(entry); }
  }
  async function save(entry:Entry, keepalive = false) {
    clearTimer(entry);
    if(closed && !keepalive)return;
    // Final close-time saves use an already-known CAS only; never start a read
    // or a retry chain after disposal.
    if(closed && !entry.ready)return;
    if (!entry.ready) { await load(entry); return; }
    if (entry.saving || entry.conflict || !entry.cache.dirty || !options.token()) return;
    const text=entry.cache.text, revision=entry.cache.revision;
    entry.saving=true;
    try {
      const result = await conversationRequest(options.token,{action:'draft_write',...entry.scope,expected_revision:revision,text},keepalive);
      if(closed)return;
      if (result.conflict) {
        // Metadata-only changes share the private CAS but don't lose a draft.
        if (result.record.draft === entry.cache.base) { entry.cache.revision=result.record.revision; }
        else { entry.conflict=result.record; notify(entry,'Draft conflict: both copies are preserved. Choose which version to keep.'); }
      } else {
        entry.cache.revision=result.record.revision; entry.cache.base=text;
        entry.cache.dirty=entry.cache.text !== text;
        notify(entry,entry.cache.dirty ? 'Saving draft…' : 'Draft saved on host.');
      }
      cache(entry);
    } catch { notify(entry,'Draft cached in this tab. Host save unavailable; reconnect to retry.'); return; }
    finally { entry.saving=false; }
    if (!closed && entry.cache.dirty && !entry.conflict) { clearTimer(entry); entry.timer=setTimeout(() => void save(entry),400); }
  }
  function edit() {
    if (closed || !active) return;
    if(active.cache.text===options.value())return;
    active.cache.text=options.value(); active.cache.dirty=true; cache(active);
    notify(active,active.conflict ? 'Draft conflict: local edits are preserved.' : 'Saving draft…');
    clearTimer(active); const entry=active;
    active.timer=setTimeout(() => void save(entry),500);
  }
  return {
    select(scope:ConversationScope, migratedText:string, preferMigrated = false) {
      if(closed)return;
      const identity=JSON.stringify({workspace_id:scope.workspace_id,profile_id:scope.profile_id,session_id:scope.session_id});
      const legacyKey=`orbit-conversation-draft:${identity}`;
      const key=`${legacyKey}:pane:${encodeURIComponent(options.cacheNamespace)}`;
      if (active?.key === key) { void load(active); return; }
      if (active) { cache(active); void save(active); }
      let entry=entries.get(key);
      if(!entry) {
        let saved:Cache={text:migratedText,dirty:!!migratedText};
        // Copy the old scope-only cache as a fallback; never remove or mutate it
        // because another pane may still need its recovery text.
        for(const candidate of [key,legacyKey]) {
          try {
            const raw=JSON.parse(sessionStorage.getItem(candidate) || 'null');
            if(raw && typeof raw.text==='string' && raw.text.length<=100000 && typeof raw.dirty==='boolean' && (raw.base===undefined || typeof raw.base==='string' && raw.base.length<=100000) && (raw.revision===undefined || Number.isSafeInteger(raw.revision) && raw.revision>=0)) {
              saved=raw;
              // The original pane/session text is more specific than a shared
              // old recovery key another pane may have overwritten. Preserve it
              // as a local change, retaining the old base for conflict review.
              if(candidate===legacyKey && migratedText && saved.text!==migratedText)saved={...saved,text:migratedText,dirty:true};
              break;
            }
          }catch{}
        }
        if(preferMigrated && saved.text!==migratedText)saved={...saved,text:migratedText,dirty:true};
        entry={scope,key,cache:saved,ready:false,saving:false};entries.set(key,entry);
      }
      // X -> Y -> X returns the same entry, including edits made while X's
      // request was pending. No obsolete entry can replace its cache later.
      active=entry; options.restore(entry.cache.text); cache(entry);
      notify(entry,entry.conflict ? 'Draft conflict: both copies are preserved. Choose which version to keep.' : entry.cache.dirty ? 'Saving draft…' : entry.ready ? 'Draft saved on host.' : 'Restoring host draft…');
      void load(entry);
    },
    edit,
    retry() { if (!closed && active) void save(active); },
    flush() { if (!closed && active) { cache(active); void save(active,true); } },
    dispose() {
      if(closed)return;
      for(const entry of entries.values()) {clearTimer(entry);cache(entry);}
      closed=true;
      // At most one final write, only when the active CAS is known and idle.
      // In-flight completions cannot cache, restore, or schedule another save.
      if(active && active.ready && !active.saving)void save(active,true);
    },
  };
}
