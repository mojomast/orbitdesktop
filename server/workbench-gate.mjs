import {wbError} from './workbench-store.mjs';

// One runtime agent lane and one managed-job lane. A Workbench run may wait for
// an approved job, but neither lane dispatches parallel work. The existing queue
// registers its durable status; unknown legacy submissions fence new Workbench
// dispatch rather than being silently migrated, dropped, or replayed.
export function createWorkbenchGate({legacySnapshot}={}){
  const active=new Map();let legacy=legacySnapshot??(()=>({enabled:false,active:0,uncertain:0,pending:0}));
  const lane=kind=>{if(!['agent','legacy-agent','job'].includes(kind))throw wbError('invalid_request');return kind==='legacy-agent'?'agent':kind;};
  function legacyStatus(){const value=legacy();return {enabled:!!value.enabled,active:Number(value.active)||0,uncertain:Number(value.uncertain)||0,pending:Number(value.pending)||0};}
  function legacyBlocked(){const status=legacyStatus();return status.enabled||status.active>0||status.uncertain>0;}
  return {
    setLegacyStatus(fn){if(typeof fn!=='function')throw wbError('invalid_request');legacy=fn;},
    legacyStatus,
    busy(kind){return active.has(lane(kind))||(kind!=='legacy-agent'&&legacyBlocked());},
    claim(kind,id){
      if(typeof id!=='string'||!id||id.length>200)throw wbError('invalid_request');
      const key=lane(kind);
      if(active.has(key)||(kind!=='legacy-agent'&&legacyBlocked())||(kind==='legacy-agent'&&active.has('job')))throw wbError('busy');
      const receipt=Symbol(id);active.set(key,receipt);let released=false;
      return ()=>{if(released)return;released=true;if(active.get(key)===receipt)active.delete(key);};
    },
    status(){return {agent:active.has('agent'),job:active.has('job'),legacy:legacyStatus()};},
  };
}
