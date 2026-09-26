import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import {randomUUID, createHash} from 'node:crypto';
import {validate} from '../src/model.ts';
import {validateDockingPlacement,emptyPlacement,placementEqual,prunePlacement} from '../src/docking-placement.ts';
import {applyOperation} from '../src/workspace-ops.ts';
import {canonicalJson} from './command-identity.mjs';
import {bundleSchemaSql,createBundleRegistry} from './bundle-registry.mjs';
import {workbenchSchemaSql} from './workbench-store.mjs';
import {workbenchExecutionSchemaSql,workbenchOperationSchemaSql,workbenchResultSchemaSql} from './workbench-data.mjs';

const uuid = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const checkId = id => { if(typeof id!=='string'||!uuid.test(id))throw failure('INVALID_OPERATION'); return id; };
function failure(category) { return Object.assign(Error(category),{category}); }
function missing() { return Object.assign(Error('Workspace unavailable'),{code:'ENOENT',category:'RESOURCE_GONE'}); }
function stateCheck(state) { validate(structuredClone(state)); return state; }
function safeInteger(value,min=0) { return Number.isSafeInteger(value)&&value>=min; }

// This store has one synchronous logical writer per command. SQLite IMMEDIATE
// transactions also arbitrate other processes; no async/network work runs inside.
export class SqliteWorkspaceStore {
  constructor(root,{importLegacy=false,busyTimeoutMs=1000}={}) {
    if(!safeInteger(busyTimeoutMs)||busyTimeoutMs>5000)throw failure('INVALID_OPERATION');
    this.root=path.resolve(root);
    this.projectionErrors=new Set();
    this.filename=path.join(this.root,'workspace.sqlite');
    fs.mkdirSync(this.root,{recursive:true,mode:0o700});
    if(fs.existsSync(this.filename) && (!fs.lstatSync(this.filename).isFile()||fs.lstatSync(this.filename).isSymbolicLink()))throw failure('INVALID_STORE');
    const exists=fs.existsSync(this.filename);
    const legacyDirectory=path.join(this.root,'workspaces');
    const legacyPresent=fs.existsSync(legacyDirectory)&&fs.readdirSync(legacyDirectory).some(name=>name.endsWith('.json'));
    if(!exists&&legacyPresent&&!importLegacy)throw failure('MIGRATION_REQUIRED');
    if(!exists)fs.closeSync(fs.openSync(this.filename,'wx',0o600));
    this.db=new Database(this.filename,{timeout:busyTimeoutMs});
    try {
      const version=this.db.pragma('user_version',{simple:true});
       if(version>8)throw failure('UPGRADE_REQUIRED');
      if(exists&&version===0&&!legacyPresent&&!importLegacy)throw failure('STORE_UNINITIALIZED');
      fs.chmodSync(this.filename,0o600);
      this.db.pragma('foreign_keys = ON');
      if(this.db.pragma('journal_mode = WAL',{simple:true})!=='wal')throw failure('UNSUPPORTED_FILESYSTEM');
      this.db.pragma('synchronous = FULL');
      this.db.pragma(`busy_timeout = ${busyTimeoutMs}`);
      const ready=version>=1&&this.db.prepare("SELECT value FROM store_metadata WHERE key='bootstrap_complete'").get()?.value==='1';
      if(version>=2&&!ready)throw failure('INVALID_STORE');
      if(!ready) {
        if(legacyPresent&&!importLegacy)throw failure('MIGRATION_REQUIRED');
        const legacy=legacyPresent?this.loadLegacy():{records:[],checkpoints:[],originals:[]};
        this.db.transaction(()=>{
          this.db.exec(`
            CREATE TABLE IF NOT EXISTS store_metadata(key TEXT PRIMARY KEY, value TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS workspaces(id TEXT PRIMARY KEY, revision INTEGER NOT NULL CHECK(revision>0), record_json TEXT NOT NULL CHECK(json_valid(record_json)));
            CREATE TABLE IF NOT EXISTS revisions(workspace_id TEXT NOT NULL REFERENCES workspaces(id), revision INTEGER NOT NULL, state_json TEXT NOT NULL CHECK(json_valid(state_json)), created INTEGER NOT NULL, PRIMARY KEY(workspace_id,revision));
            CREATE TABLE IF NOT EXISTS checkpoints(workspace_id TEXT NOT NULL REFERENCES workspaces(id), id TEXT NOT NULL, revision INTEGER NOT NULL, created INTEGER NOT NULL, label TEXT NOT NULL, state_json TEXT NOT NULL CHECK(json_valid(state_json)), PRIMARY KEY(workspace_id,id));
            CREATE TABLE IF NOT EXISTS receipts(workspace_id TEXT NOT NULL REFERENCES workspaces(id), actor TEXT NOT NULL, operation_id TEXT NOT NULL, request_hash TEXT NOT NULL, intent TEXT NOT NULL, base_revision INTEGER NOT NULL, result_json TEXT NOT NULL CHECK(json_valid(result_json)), record_json TEXT NOT NULL CHECK(json_valid(record_json)), created INTEGER NOT NULL, PRIMARY KEY(workspace_id,actor,operation_id));
            CREATE TABLE IF NOT EXISTS events(sequence INTEGER PRIMARY KEY AUTOINCREMENT, event_json TEXT NOT NULL CHECK(json_valid(event_json)));
            CREATE TABLE IF NOT EXISTS legacy_imports(relative_path TEXT PRIMARY KEY, sha256 TEXT NOT NULL, original BLOB NOT NULL);
          `);
          for(const record of legacy.records) {
            this.putRecord(record);
            this.putRevision(record,0);
          }
          for(const {workspaceId,entry} of legacy.checkpoints)this.insertCheckpoint(workspaceId,entry);
          for(const original of legacy.originals)this.db.prepare('INSERT INTO legacy_imports VALUES (?,?,?)').run(original.relative,original.hash,original.bytes);
          this.db.prepare("INSERT INTO store_metadata VALUES ('bootstrap_complete','1')").run();
          this.db.pragma('user_version = 1');
        }).immediate();
      }
      // Bootstrap remains v1 so legacy import is atomic and independently
      // restartable. Upgrade under the writer lock; old binaries refuse v2.
      this.db.transaction(()=>{
        const current=this.db.pragma('user_version',{simple:true});
         if(current>8)throw failure('UPGRADE_REQUIRED');
        if(current===1) {
          this.db.exec(`
            ALTER TABLE receipts ADD COLUMN policy_generation INTEGER NOT NULL DEFAULT 0 CHECK(policy_generation>=0);
            UPDATE workspaces SET record_json=json_set(record_json,'$.recovery_policy',json('{"held":false,"generation":0}'));
            UPDATE receipts SET record_json=json_set(record_json,'$.recovery_policy',json('{"held":false,"generation":0}'));
          `);
          this.db.pragma('user_version = 2');
        }
      }).immediate();
      this.db.transaction(()=>{
        const current=this.db.pragma('user_version',{simple:true});
         if(current>8)throw failure('UPGRADE_REQUIRED');
        if(current===2) {
          this.db.exec(bundleSchemaSql);
          this.db.exec("CREATE INDEX IF NOT EXISTS events_workspace_sequence ON events(json_extract(event_json,'$.workspace_id'),sequence)");
          this.db.pragma('user_version = 3');
        }
      }).immediate();
      // Schema-3 binaries strictly refuse schema 4 at startup (UPGRADE_REQUIRED).
      // Already-open old writers must be stopped: no mixed-version writers supported.
      this.db.transaction(()=>{
        const current=this.db.pragma('user_version',{simple:true});
         if(current>8)throw failure('UPGRADE_REQUIRED');
        if(current===3) {
          // Guard each column add: a database rewound to an older user_version (or
          // an interrupted earlier upgrade) may already carry the placement columns.
          const columns = table => new Set(this.db.prepare(`PRAGMA table_info(${table})`).all().map(column=>column.name));
          if(!columns('checkpoints').has('placement_json'))this.db.exec('ALTER TABLE checkpoints ADD COLUMN placement_json TEXT;');
          if(!columns('revisions').has('placement_json'))this.db.exec('ALTER TABLE revisions ADD COLUMN placement_json TEXT;');
          this.db.exec(`
            UPDATE checkpoints SET placement_json='{"version":1,"layout":null,"floats":[],"active":null}' WHERE placement_json IS NULL;
            UPDATE workspaces SET record_json=json_set(record_json,'$.placement',coalesce(json_extract(record_json,'$.placement'),json('{"version":1,"layout":null,"floats":[],"active":null}')),'$.placement_revision',coalesce(json_extract(record_json,'$.placement_revision'),0));
          `);
          this.db.pragma('user_version = 4');
        }
      }).immediate();
      this.db.transaction(()=>{
        const current=this.db.pragma('user_version',{simple:true});
         if(current>8)throw failure('UPGRADE_REQUIRED');
        if(current===4){this.db.exec(workbenchSchemaSql);this.db.pragma('user_version = 5');}
      }).immediate();
      this.db.transaction(()=>{
        const current=this.db.pragma('user_version',{simple:true});
         if(current>8)throw failure('UPGRADE_REQUIRED');
        if(current===5){this.db.exec(workbenchExecutionSchemaSql);this.db.pragma('user_version = 6');}
      }).immediate();
      this.db.transaction(()=>{
        const current=this.db.pragma('user_version',{simple:true});
         if(current>8)throw failure('UPGRADE_REQUIRED');
        if(current===6){
          // Never discard conflicting historical receipts to manufacture uniqueness.
          // A conflicted source requires explicit operator investigation on a copy.
          const conflicts=this.db.prepare("SELECT 1 FROM wb_jobs WHERE json_extract(record_json,'$.op_id') IS NOT NULL GROUP BY workspace_id,project_id,json_extract(record_json,'$.op_id') HAVING count(*)>1 LIMIT 1").get();
          if(conflicts)throw failure('MIGRATION_INVALID');
          this.db.exec(workbenchExecutionSchemaSql+workbenchOperationSchemaSql);
          this.db.pragma('user_version = 7');
        }
       }).immediate();
       this.db.transaction(()=>{
         const current=this.db.pragma('user_version',{simple:true});
         if(current>8)throw failure('UPGRADE_REQUIRED');
         if(current===7){this.db.exec(workbenchResultSchemaSql);this.db.pragma('user_version = 8');}
       }).immediate();
      this.bundles=createBundleRegistry({db:this.db,root:this.root});
      // Rebuildable discovery only. Frozen original workspace JSON is never updated.
      this.reconcileConnections();
    } catch(error) {this.db.close(); throw error;}
  }
  loadLegacy() {
    const records=[],checkpoints=[],originals=[];
    let total=0;
    const load=relative=>{
      const filename=path.join(this.root,relative),stat=fs.lstatSync(filename);
      if(!stat.isFile()||stat.isSymbolicLink()||stat.size>8*1024*1024||(total+=stat.size)>128*1024*1024)throw failure('MIGRATION_INVALID');
      const bytes=fs.readFileSync(filename);
      originals.push({relative,bytes,hash:createHash('sha256').update(bytes).digest('hex')});
      return JSON.parse(bytes.toString('utf8'));
    };
    for(const directory of ['workspaces','checkpoints'])if(fs.existsSync(path.join(this.root,directory)) && (!fs.lstatSync(path.join(this.root,directory)).isDirectory()||fs.lstatSync(path.join(this.root,directory)).isSymbolicLink()))throw failure('MIGRATION_INVALID');
    for(const name of fs.readdirSync(path.join(this.root,'workspaces')).filter(name=>name.endsWith('.json')).sort()) {
      const id=checkId(name.slice(0,-5)),record=load(path.join('workspaces',name));
      if(record.id!==id||!safeInteger(record.revision,1)||typeof record.capability!=='string'||!record.capability||typeof record.api!=='string')throw failure('MIGRATION_INVALID');
      stateCheck(record.state);
      records.push(record);
      const directory=path.join(this.root,'checkpoints',id);
      if(fs.existsSync(directory)&&(!fs.lstatSync(directory).isDirectory()||fs.lstatSync(directory).isSymbolicLink()))throw failure('MIGRATION_INVALID');
      if(fs.existsSync(directory))for(const checkpointName of fs.readdirSync(directory).filter(name=>name.endsWith('.json')).sort()) {
        const entry=load(path.join('checkpoints',id,checkpointName));
        if(entry.id!==checkId(checkpointName.slice(0,-5))||!safeInteger(entry.revision,1)||!Number.isFinite(entry.created)||typeof entry.label!=='string')throw failure('MIGRATION_INVALID');
        stateCheck(entry.state);
        checkpoints.push({workspaceId:id,entry});
      }
    }
    const checkpointRoot=path.join(this.root,'checkpoints');
    if(fs.existsSync(checkpointRoot))for(const directory of fs.readdirSync(checkpointRoot,{withFileTypes:true})) {
      if(directory.isSymbolicLink())throw failure('MIGRATION_INVALID');
      if(directory.isDirectory()&&!records.some(record=>record.id===directory.name)&&fs.readdirSync(path.join(checkpointRoot,directory.name)).some(name=>name.endsWith('.json')))throw failure('MIGRATION_INVALID');
    }
    return {records,checkpoints,originals};
  }
  read(id) {
    const row=this.db.prepare('SELECT record_json FROM workspaces WHERE id=?').get(checkId(id));
    if(!row)throw missing();
    const record=JSON.parse(row.record_json);
    record.placement??=emptyPlacement();
    record.placement_revision??=0;
    return record;
  }
  putRecord(record) {
    this.db.prepare('INSERT INTO workspaces VALUES (?,?,?) ON CONFLICT(id) DO UPDATE SET revision=excluded.revision,record_json=excluded.record_json').run(record.id,record.revision,JSON.stringify(record));
  }
  putRevision(record,created) {
    if(this.db.pragma('user_version',{simple:true})>=4)
      this.db.prepare('INSERT INTO revisions VALUES (?,?,?,?,?)').run(record.id,record.revision,JSON.stringify(record.state),created,JSON.stringify(record.placement??emptyPlacement()));
    else
      this.db.prepare('INSERT INTO revisions VALUES (?,?,?,?)').run(record.id,record.revision,JSON.stringify(record.state),created);
  }
  insertCheckpoint(workspaceId,entry) {
    if(this.db.pragma('user_version',{simple:true})>=4)
      this.db.prepare('INSERT INTO checkpoints VALUES (?,?,?,?,?,?,?)').run(workspaceId,entry.id,entry.revision,entry.created,entry.label,JSON.stringify(entry.state),JSON.stringify(entry.placement??emptyPlacement()));
    else
      this.db.prepare('INSERT INTO checkpoints VALUES (?,?,?,?,?,?)').run(workspaceId,entry.id,entry.revision,entry.created,entry.label,JSON.stringify(entry.state));
  }
  checkpointList(id) {
    return this.db.prepare('SELECT id,revision,created,label FROM checkpoints WHERE workspace_id=? ORDER BY created DESC,id DESC').all(checkId(id));
  }
  checkpointGet(id,key) {
    const row=this.db.prepare('SELECT id,revision,created,label,state_json,placement_json FROM checkpoints WHERE workspace_id=? AND id=?').get(checkId(id),checkId(key));
    if(!row)throw missing();
    const {state_json,placement_json,...metadata}=row, state=JSON.parse(state_json);
    const placement=placement_json?validateDockingPlacement(JSON.parse(placement_json)):emptyPlacement();
    return {...metadata,state,placement:prunePlacement(placement,state.monitors.map(m=>m.id))};
  }
  commit(command,change) {
    const {workspaceId,actor,operationId,requestHash,intent,action}=command;
    checkId(workspaceId);
    if(typeof actor!=='string'||!actor||actor.length>200||typeof operationId!=='string'||!/^[a-zA-Z0-9_.:-]{1,128}$/.test(operationId)||typeof requestHash!=='string'||!/^[a-f0-9]{64}$/.test(requestHash)||typeof intent!=='string'||!intent.length||[...intent].length>160||typeof action!=='string'||action.length>100)throw failure('INVALID_OPERATION');
    try {
      const committed=this.db.transaction(()=>{
        let previous;
        try { previous=this.read(workspaceId); } catch(error) {if(error.code!=='ENOENT')throw error;}
        if(change.authorize && !change.authorize(previous))throw failure('PERMISSION_REQUIRED');
        const policy=previous?.recovery_policy||{held:false,generation:0};
        if(typeof policy.held!=='boolean'||!safeInteger(policy.generation))throw failure('INVALID_STORE');
        const receipt=this.db.prepare('SELECT request_hash,result_json,record_json,policy_generation FROM receipts WHERE workspace_id=? AND actor=? AND operation_id=?').get(workspaceId,actor,operationId);
        if(receipt) {
          if(receipt.request_hash!==requestHash)throw failure('IDEMPOTENCY_CONFLICT');
          if(receipt.policy_generation!==policy.generation)throw failure('RECOVERY_POLICY_CHANGED');
          return {record:JSON.parse(receipt.record_json),result:JSON.parse(receipt.result_json),replayed:true};
        }
        const baseRevision=command.baseRevision ?? (command.legacy?previous?.revision||0:undefined);
        if(!safeInteger(baseRevision)||baseRevision!==(previous?.revision||0))throw failure('REVISION_CONFLICT');
        // Trusted service option (boolean), not a field accepted from layout
        // state. The normal base revision CAS covers both state and policy.
        const transition=change.recoveryPolicy;
        if(transition!==undefined && (!previous||typeof transition!=='boolean'||change.checkpointOnly))throw failure('INVALID_OPERATION');
        if(change.checkpointOnly&&change.placement!==undefined)throw failure('INVALID_OPERATION');
        const now=Date.now();
        let record,checkpoint;
        if(!previous) {
          if(!change.create)throw missing();
          record=change.create();
          if(record?.then||record.id!==workspaceId||record.revision!==1||!record.capability)throw failure('INVALID_OPERATION');
          stateCheck(record.state);
          if(change.placement!==undefined) {
            record.placement=validateDockingPlacement(change.placement,{windowIds:record.state.monitors.map(m=>m.id)});
            record.placement_revision=placementEqual(record.placement,emptyPlacement())?0:record.revision;
          }
        } else {
          if(previous.state?.version!==1)throw failure('UPGRADE_REQUIRED');
          record=structuredClone(previous);
          if(!change.checkpointOnly) {
            const state=transition!==undefined
              ? (transition?applyOperation(structuredClone(previous.state),{action:'plugin_disable_all'}):structuredClone(previous.state))
              : change.apply?change.apply(structuredClone(previous)):structuredClone(previous.state);
            if(state?.then)throw failure('INVALID_OPERATION');
            stateCheck(state);
            const stateChanged=canonicalJson(state)!==canonicalJson(previous.state);
            const nextPlacement=change.placement===undefined?prunePlacement(previous.placement??emptyPlacement(),state.monitors.map(m=>m.id)):validateDockingPlacement(change.placement,{windowIds:state.monitors.map(m=>m.id)});
            const placementChanged=!placementEqual(nextPlacement,previous.placement??emptyPlacement());
            record.state=state;
            if(stateChanged||placementChanged||!change.skipUnchanged||transition!==undefined)record.revision++;
            record.placement=nextPlacement;
            if(placementChanged)record.placement_revision=record.revision;
          }
          if(change.checkpointLabel!==undefined && (change.checkpointOnly||record.revision!==previous.revision)) {
            checkpoint={id:randomUUID(),created:now,label:[...String(change.checkpointLabel||'Checkpoint')].slice(0,160).join(''),revision:previous.revision,state:previous.state,placement:previous.placement??emptyPlacement()};
            this.insertCheckpoint(workspaceId,checkpoint);
          }
        }
        record.placement??=emptyPlacement();
        record.placement_revision??=0;
        record.recovery_policy=transition===undefined?structuredClone(policy):{held:transition,generation:policy.generation+1};
        if(!safeInteger(record.recovery_policy.generation))throw failure('INVALID_OPERATION');
        // Gate the final validated state for every mutation, including whole-state
        // sync/restore. Policy is authoritative metadata, never checkpoint state.
        if(record.recovery_policy.held && record.state.plugins?.some(plugin=>plugin.enabled||record.state.monitors.some(monitor=>monitor.id===plugin.window.id)))throw failure('RECOVERY_HOLD');
        // Check indexed new/activated references without scanning the filesystem
        // under the writer lock. Existing broken refs must not trap recovery edits.
        if(!change.checkpointOnly && transition===undefined)this.bundles.validateState(record.state,{previousState:previous?.state,onlyChanged:true});
        if(change.api)record.api=change.api;
        this.putRecord(record);
        if(!previous||record.revision!==previous.revision)this.putRevision(record,now);
        const result=change.response?change.response(structuredClone(record),checkpoint):structuredClone(record);
        if(result?.then)throw failure('INVALID_OPERATION');
        const resultJson=JSON.stringify(result);
        if(Buffer.byteLength(resultJson)>2_000_000)throw failure('REQUEST_TOO_LARGE');
        // A policy transition can be replayed while its resulting generation is
        // still current; every receipt expires when the policy next changes.
        this.db.prepare('INSERT INTO receipts VALUES (?,?,?,?,?,?,?,?,?,?)').run(workspaceId,actor,operationId,requestHash,intent,baseRevision,resultJson,JSON.stringify(record),now,record.recovery_policy.generation);
        const event={id:randomUUID(),schema_version:1,workspace_id:workspaceId,resource_id:null,type:'workspace.command',timestamp:now,causation_id:operationId,correlation_id:operationId,payload:{action,revision:record.revision,changed:!previous||previous.revision!==record.revision,recovery_policy:record.recovery_policy}};
        this.db.prepare('INSERT INTO events(event_json) VALUES (?)').run(JSON.stringify(event));
        return {record,result,replayed:false};
      }).immediate();
      if(!committed.replayed)this.publishConnection(committed.record);
      return committed;
    } catch(error) {
      if(error.code==='SQLITE_BUSY')throw failure('RESOURCE_BUSY');
      throw error;
    }
  }
  observe(id,{observedRevision,api,now=Date.now()}={}) {
    const record=this.db.transaction(()=>{
      const current=this.read(id);
      if(observedRevision!==undefined)current.observed_revision=Math.min(current.revision,safeInteger(observedRevision)?observedRevision:0);
      current.browser_seen=now;
      if(api)current.api=api;
      this.putRecord(current);return current;
    }).immediate();
    this.publishConnection(record);return record;
  }
  connection(id) {const record=this.read(id);return {workspace_id:id,storage:'sqlite-v1',api:record.api,capability:record.capability};}
  publishConnection(record) {
    // Projection errors cannot turn a committed command into an apparent rollback.
    // Restart/reconcile repairs this projection from the authoritative DB.
    try {
      const directory=path.join(this.root,'workspace-access');fs.mkdirSync(directory,{recursive:true,mode:0o700});
      fs.chmodSync(directory,0o700);
      const file=path.join(directory,`${record.id}.json`),data=JSON.stringify({workspace_id:record.id,storage:'sqlite-v1',api:record.api,capability:record.capability});
      if(fs.existsSync(file)&&!fs.lstatSync(file).isSymbolicLink()&&fs.readFileSync(file,'utf8')===data) {fs.chmodSync(file,0o600);this.projectionErrors.delete(record.id);return;}
      const temporary=`${file}.${randomUUID()}.tmp`;
      try {fs.writeFileSync(temporary,data,{mode:0o600,flag:'wx'});fs.renameSync(temporary,file);} finally {fs.rmSync(temporary,{force:true});}
      this.projectionErrors.delete(record.id);
    } catch {this.projectionErrors.add(record.id);}
    finally {this.projectionError=this.projectionErrors.size>0;}
  }
  reconcileConnections(api) {
    for(const {id} of this.db.prepare('SELECT id FROM workspaces').all()) {
      let record=this.read(id);
      if(api && record.api!==api) {
        record=this.db.transaction(()=>{const current=this.read(id);current.api=api;this.putRecord(current);return current;}).immediate();
      }
      this.publishConnection(record);
    }
  }
  eventsAfter(cursor,limit=100) {
    if(!safeInteger(cursor)||!safeInteger(limit,1)||limit>1000)throw failure('INVALID_OPERATION');
    return this.db.prepare('SELECT sequence,event_json FROM events WHERE sequence>? ORDER BY sequence LIMIT ?').all(cursor,limit).map(({sequence,event_json})=>({...JSON.parse(event_json),sequence}));
  }
  eventPage(id,cursor=0,limit=100) {
    checkId(id);
    if(!safeInteger(cursor)||!safeInteger(limit,1)||limit>100)throw failure('INVALID_OPERATION');
    return this.db.transaction(()=>{
      this.read(id);
      // Scope before ordering/limiting. Never advance a cursor using another
      // workspace's event, including when this workspace has no new events.
      const latest=this.db.prepare("SELECT sequence FROM events WHERE json_extract(event_json,'$.workspace_id')=? ORDER BY sequence DESC LIMIT 1").get(id)?.sequence||0;
      const expiredThrough=this.db.prepare("SELECT sequence FROM events WHERE json_extract(event_json,'$.workspace_id')=? ORDER BY sequence DESC LIMIT 1 OFFSET 1000").get(id)?.sequence||0;
      if(cursor>latest || cursor<expiredThrough)return {workspace_id:id,events:[],cursor:latest,has_more:false,reset_required:true};
      const rows=this.db.prepare("SELECT sequence,event_json FROM events WHERE json_extract(event_json,'$.workspace_id')=? AND sequence>? ORDER BY sequence LIMIT ?").all(id,cursor,limit+1);
      const events=rows.slice(0,limit).map(({sequence,event_json})=>{
        const event=JSON.parse(event_json),payload=event.payload||{};
        // Explicit allowlist, not a spread of a future event's private payload.
        return {sequence,type:event.type,timestamp:event.timestamp,causation_id:event.causation_id,correlation_id:event.correlation_id,payload:{action:payload.action,revision:payload.revision,changed:payload.changed,...(payload.recovery_policy?{recovery_policy:{held:payload.recovery_policy.held,generation:payload.recovery_policy.generation}}:{})}};
      });
      return {workspace_id:id,events,cursor:events.at(-1)?.sequence??cursor,has_more:rows.length>limit,reset_required:false};
    }).deferred();
  }
  async backup(destination) {
    destination=path.resolve(destination);
    // better-sqlite3 trims backup filenames. Reject ambiguous names and never
    // pass the user's destination to it: publish a finished sibling via link().
    if(destination!==destination.trim())throw failure('INVALID_DESTINATION');
    if(fs.existsSync(destination))throw failure('DESTINATION_EXISTS');
    const stage=path.join(path.dirname(destination),`.orbit-backup-${randomUUID()}.sqlite`);
    fs.closeSync(fs.openSync(stage,'wx',0o600));
    try {
      await this.db.backup(stage);
      const check=new Database(stage,{fileMustExist:true});
      try {
        // The private destination has no other users. Make it a standalone
        // backup artifact rather than publishing a file dependent on sidecars.
        check.pragma('journal_mode = DELETE');
        if(check.pragma('quick_check',{simple:true})!=='ok')throw failure('BACKUP_INVALID');
      }finally {check.close();}
      fs.linkSync(stage,destination); // exclusive atomic publication; never overwrites
      return {path:destination};
    } finally {for(const filename of [stage,stage+'-wal',stage+'-shm'])fs.rmSync(filename,{force:true});}
  }
  diagnostics() {
    return {schema_version:this.db.pragma('user_version',{simple:true}),journal_mode:this.db.pragma('journal_mode',{simple:true}),foreign_keys:this.db.pragma('foreign_keys',{simple:true}),integrity:this.db.pragma('quick_check',{simple:true}),workspaces:this.db.prepare('SELECT count(*) AS n FROM workspaces').get().n,checkpoints:this.db.prepare('SELECT count(*) AS n FROM checkpoints').get().n,receipts:this.db.prepare('SELECT count(*) AS n FROM receipts').get().n,events:this.db.prepare('SELECT count(*) AS n FROM events').get().n,projection_error:!!this.projectionError};
  }
  exportLegacy(destination) {
    // Archive includes the adjunct; rollback consumers that ignore it lose placement.
    destination=path.resolve(destination);
    if(fs.existsSync(destination))throw failure('DESTINATION_EXISTS');
    const snapshot=this.db.transaction(()=>this.db.prepare('SELECT id FROM workspaces ORDER BY id').all().map(({id})=>({record:this.read(id),checkpoints:this.checkpointList(id).map(entry=>this.checkpointGet(id,entry.id))}))).deferred();
    if(snapshot.some(({record})=>record.recovery_policy.held))throw failure('RECOVERY_HOLD');
    const stage=fs.mkdtempSync(path.join(path.dirname(destination),'.orbit-export-'));
    try {
      fs.mkdirSync(path.join(stage,'workspaces'),{mode:0o700});
      for(const {record,checkpoints} of snapshot) {
        if(record.state?.version!==1)throw failure('UPGRADE_REQUIRED');
        fs.writeFileSync(path.join(stage,'workspaces',`${record.id}.json`),JSON.stringify(record),{mode:0o600});
        const directory=path.join(stage,'checkpoints',record.id);fs.mkdirSync(directory,{recursive:true,mode:0o700});
        for(const checkpoint of checkpoints)fs.writeFileSync(path.join(directory,`${checkpoint.id}.json`),JSON.stringify(checkpoint),{mode:0o600});
      }
      fs.writeFileSync(path.join(stage,'EXPORT_WARNING.txt'),'Offline legacy layout export only. Project Workbench records and registration policies are NOT exported. Receipts/outbox are NOT preserved by old binaries. Immutable bundles and other runtime resources must be retained separately. No services have been started.\n',{mode:0o600});
      if(fs.existsSync(destination))throw failure('DESTINATION_EXISTS');
      fs.renameSync(stage,destination);
      return {path:destination,workspaces:snapshot.length};
    } finally {fs.rmSync(stage,{recursive:true,force:true});}
  }
  close() {if(this.db.open)this.db.close();}
}
