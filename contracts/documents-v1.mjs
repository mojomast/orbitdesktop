// Private owner documents. This contract is independent of Workbench and layout.
export const DOCUMENT_LIMITS = Object.freeze({richtext: 262144, scene: 524288, documents: 256, receipts: 128, depth: 32, nodes: 12000});
export const DOCUMENT_UUID = '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';
// Reviewed shipping policy: no legacy/system/server-export font admission.
export const CANVAS_FONT_IDS = Object.freeze([5,6,7,8]);
export const CANVAS_FONT_FAMILIES = Object.freeze(['Assistant','ComicShanns','Excalifont','Lilita','Nunito','Xiaolai']);
export const CANVAS_FONT_POLICY_KEY = 'orbit.canvas-font-policy.v1';
const id = {type:'string', pattern:DOCUMENT_UUID};
const revision = {type:'integer', minimum:0, maximum:Number.MAX_SAFE_INTEGER - 1};
const title = {type:'string', minLength:1, maxLength:160, pattern:'^[^\\u0000-\\u001f\\u007f]*$'};
const data = {type:'object', additionalProperties:false, required:['kind','format','content'], properties:{kind:{enum:['richtext','scene']},format:{enum:['lexical','excalidraw']},content:{type:'string',maxLength:524288}}};
const base = {workspace_id:id};
const selection = {...base,document_id:id,pane_id:id};
const mutation = {op_id:id,intent:{type:'string',minLength:1,maxLength:200}};
const action = (name, properties, required=Object.keys(properties)) => ({type:'object',additionalProperties:false,required:['action',...required],properties:{action:{const:name},...properties}});
export const documentsRequestSchema = {oneOf:[
  action('list',base),
  action('create',{...base,...mutation,document_id:id,title,kind:{enum:['richtext','scene']}}),
  action('resolve',selection),
  // The authenticated owner library can read without a pane; a supplied pane
  // selector must always match the exact live URL, including for exact retries.
  action('read',selection,['workspace_id','document_id']),
  action('save',{...selection,...mutation,expected_revision:revision,data}),
  action('rename',{...selection,...mutation,expected_revision:revision,title}),
  action('receipt',{...selection,op_id:id}),
]};
const fail = code => {throw Object.assign(Error(code),{code});};
const object = value => value && typeof value === 'object' && !Array.isArray(value);
const own = (value, fields) => object(value) && Object.keys(value).every(k => fields.includes(k));
const lexicalTypes = new Set(['root','paragraph','text','linebreak','heading','quote','list','listitem','link','autolink','code','code-highlight','tab']);
const lexicalFields = ['children','direction','format','indent','type','version','text','detail','mode','style','tag','listType','start','value','checked','url','rel','target','title','isUnlinked','language','highlightType','textFormat','textStyle'];
const elementTypes = new Set(['rectangle','diamond','ellipse','line','arrow','freedraw','text','frame','magicframe']);
const elementFields = ['id','index','type','x','y','width','height','angle','strokeColor','backgroundColor','fillStyle','strokeWidth','strokeStyle','roughness','opacity','groupIds','frameId','roundness','seed','version','versionNonce','isDeleted','boundElements','updated','link','locked','points','lastCommittedPoint','startBinding','endBinding','startArrowhead','endArrowhead','elbowed','fixedSegments','startIsSpecial','endIsSpecial','pressures','simulatePressure','fontSize','fontFamily','text','originalText','textAlign','verticalAlign','containerId','autoResize','lineHeight'];
export const EMPTY_RICHDOC = JSON.stringify({root:{children:[{children:[],direction:null,format:'',indent:0,type:'paragraph',version:1,textFormat:0,textStyle:''}],direction:null,format:'',indent:0,type:'root',version:1}});
export const EMPTY_CANVAS = JSON.stringify({type:'excalidraw',version:2,source:'Orbit',elements:[],appState:{viewBackgroundColor:'#ffffff'},files:{}});
// Bound before parsing and before invoking either third-party renderer. Reject
// executable node types, binary assets, prototype keys and unbounded recursion.
export function validateDocumentData(data) {
  if (!own(data,['kind','format','content']) || !['richtext','scene'].includes(data.kind) || data.format !== (data.kind === 'richtext' ? 'lexical':'excalidraw') || typeof data.content !== 'string') fail('invalid_request');
  const bytes = typeof Buffer === 'undefined' ? new TextEncoder().encode(data.content).length : Buffer.byteLength(data.content);
  if (bytes > DOCUMENT_LIMITS[data.kind]) fail('limit_exceeded');
  let parsed; try {parsed=JSON.parse(data.content);} catch {fail('invalid_request');}
  let count=0;
  function bounded(v,depth=0) {
    if (++count>DOCUMENT_LIMITS.nodes || depth>DOCUMENT_LIMITS.depth) fail('limit_exceeded');
    if (typeof v==='number' && !Number.isFinite(v)) fail('invalid_request');
    if (v && typeof v==='object') for (const [k,x] of Object.entries(v)) {
      if (['__proto__','prototype','constructor'].includes(k)) fail('invalid_request');
      bounded(x,depth+1);
    }
  }
  bounded(parsed);
  const safeUrl = url => url === null || url === undefined || (typeof url==='string' && url.length<=2048 && /^https?:\/\//i.test(url));
  if (data.kind==='richtext') {
    if (!own(parsed,['root']) || parsed.root?.type!=='root') fail('invalid_request');
    function node(n) {
      if (!own(n,lexicalFields) || !lexicalTypes.has(n.type) || n.version!==1) fail('invalid_request');
      if ('style' in n && n.style!=='' || 'textStyle' in n && n.textStyle!=='') fail('invalid_request');
      if ('text' in n && typeof n.text!=='string' || 'url' in n && !safeUrl(n.url)) fail('invalid_request');
      if ('format' in n && !(Number.isSafeInteger(n.format) && n.format>=0 && n.format<=2047) && !['','left','right','center','justify','start','end'].includes(n.format)) fail('invalid_request');
      if ('indent' in n && (!Number.isSafeInteger(n.indent) || n.indent<0 || n.indent>20)) fail('invalid_request');
      if ('direction' in n && ![null,'ltr','rtl'].includes(n.direction)) fail('invalid_request');
      for (const field of ['detail','textFormat','start','value']) if (field in n && (!Number.isSafeInteger(n[field]) || Math.abs(n[field])>1000000)) fail('invalid_request');
      if ('mode' in n && !['normal','token','segmented'].includes(n.mode) || 'checked' in n && ![null,true,false].includes(n.checked) || 'listType' in n && !['number','bullet','check'].includes(n.listType)) fail('invalid_request');
      for (const field of ['rel','target','title','language','highlightType']) if (field in n && n[field]!==null && (typeof n[field]!=='string'||n[field].length>2048)) fail('invalid_request');
      if ('isUnlinked' in n && typeof n.isUnlinked!=='boolean') fail('invalid_request');
      if (['link','autolink'].includes(n.type) && (typeof n.url!=='string'||!safeUrl(n.url))) fail('invalid_request');
      if (n.type==='heading' && !['h1','h2','h3','h4','h5','h6'].includes(n.tag)) fail('invalid_request');
      if ('tag' in n && !['h1','h2','h3','h4','h5','h6','ol','ul'].includes(n.tag)) fail('invalid_request');
      if ('children' in n) {if (!Array.isArray(n.children)) fail('invalid_request'); n.children.forEach(node);}
      else if (!['text','linebreak','code-highlight','tab'].includes(n.type)) fail('invalid_request');
    }
    node(parsed.root);
  } else {
    if (!own(parsed,['type','version','source','elements','appState','files']) || parsed.type!=='excalidraw' || parsed.version!==2 || !Array.isArray(parsed.elements) || parsed.elements.length>2000 || !own(parsed.files,[]) || !own(parsed.appState,['viewBackgroundColor','gridSize','gridStep','gridModeEnabled'])) fail('invalid_request');
    const ids=new Set();
    for (const e of parsed.elements) {
      if (!own(e,elementFields) || !elementTypes.has(e.type) || typeof e.id!=='string' || e.id.length>100 || ids.has(e.id) || !safeUrl(e.link)) fail('invalid_request');
      ids.add(e.id);
      for (const key of ['x','y','width','height','angle','version','seed','versionNonce']) if (typeof e[key]!=='number' || !Number.isFinite(e[key]) || Math.abs(e[key])>1e12) fail('invalid_request');
      if (typeof e.isDeleted!=='boolean') fail('invalid_request');
      for (const key of ['strokeWidth','roughness','opacity','updated','fontFamily','lineHeight']) if (key in e && (typeof e[key]!=='number'||!Number.isFinite(e[key])||Math.abs(e[key])>1e15)) fail('invalid_request');
      for (const [key,max] of [['strokeWidth',1000],['roughness',10],['opacity',100],['lineHeight',100]]) if (key in e && (e[key]<0||e[key]>max)) fail('invalid_request');
      if ('fontFamily' in e && !CANVAS_FONT_IDS.includes(e.fontFamily)) throw Object.assign(Error('Unsupported canvas font. Use Excalifont (5), Nunito (6), Lilita One (7), or Comic Shanns (8); convert legacy text before importing.'),{code:'unsupported',reason:'unsupported_canvas_font'});
      for (const key of ['locked','elbowed','startIsSpecial','endIsSpecial','simulatePressure','autoResize']) if (key in e && typeof e[key]!=='boolean') fail('invalid_request');
      for (const key of ['frameId','containerId','index']) if (key in e && e[key]!==null && (typeof e[key]!=='string'||e[key].length>100)) fail('invalid_request');
      if ('groupIds' in e && (!Array.isArray(e.groupIds)||e.groupIds.some(id=>typeof id!=='string'||id.length>100))) fail('invalid_request');
      if ('boundElements' in e && e.boundElements!==null && (!Array.isArray(e.boundElements)||e.boundElements.some(b=>!own(b,['id','type'])||typeof b.id!=='string'||b.id.length>100||!['text','arrow'].includes(b.type)))) fail('invalid_request');
      if ('roundness' in e && e.roundness!==null && (!own(e.roundness,['type','value'])||!Number.isSafeInteger(e.roundness.type)||('value' in e.roundness&&!Number.isFinite(e.roundness.value)))) fail('invalid_request');
      for (const key of ['startBinding','endBinding']) if (key in e && e[key]!==null && (!own(e[key],['elementId','focus','gap','fixedPoint'])||typeof e[key].elementId!=='string'||e[key].elementId.length>100||!Number.isFinite(e[key].focus)||!Number.isFinite(e[key].gap))) fail('invalid_request');
      for (const key of ['text','originalText','strokeColor','backgroundColor']) if (key in e && (typeof e[key]!=='string' || e[key].length>100000 || /url\s*\(/i.test(e[key]))) fail('invalid_request');
      if (e.type==='text' && (typeof e.text!=='string' || !CANVAS_FONT_IDS.includes(e.fontFamily) || !Number.isFinite(e.fontSize) || e.fontSize<1 || e.fontSize>1000)) fail('invalid_request');
      if ('points' in e && (!Array.isArray(e.points) || e.points.some(p=>!Array.isArray(p)||p.length!==2||p.some(n=>typeof n!=='number'||!Number.isFinite(n)||Math.abs(n)>1e12)))) fail('invalid_request');
    }
    if ('viewBackgroundColor' in parsed.appState && (typeof parsed.appState.viewBackgroundColor!=='string' || !/^#[a-f0-9]{3,8}$/i.test(parsed.appState.viewBackgroundColor))) fail('invalid_request');
    for (const key of ['gridSize','gridStep']) if (key in parsed.appState && parsed.appState[key]!==null && (!Number.isFinite(parsed.appState[key])||parsed.appState[key]<0||parsed.appState[key]>10000)) fail('invalid_request');
    if ('gridModeEnabled' in parsed.appState && typeof parsed.appState.gridModeEnabled!=='boolean') fail('invalid_request');
  }
  return parsed;
}
