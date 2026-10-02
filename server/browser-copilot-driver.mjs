import {createHash,randomUUID} from 'node:crypto';
import {access} from 'node:fs/promises';
import {constants} from 'node:fs';
import {lookup} from 'node:dns/promises';
import {isIP,BlockList} from 'node:net';
import {COPILOT_LIMITS} from '../contracts/browser-copilot-v1.mjs';

export const copilotError=code=>Object.assign(new Error(code),{code});
export const digest=bytes=>createHash('sha256').update(bytes).digest('hex');
const privateAddress=ip=>ip.includes(':') ? !/^2[0-9a-f]{3}:/i.test(ip) : /^(0|10|127|169\.254|192\.168|172\.(1[6-9]|2\d|3[01])|224|240|255)\./.test(ip);

const localAddresses=new BlockList();
for(const [address,prefix] of [['0.0.0.0',32],['127.0.0.0',8],['10.0.0.0',8],['172.16.0.0',12],['192.168.0.0',16],['169.254.0.0',16],['100.64.0.0',10]])localAddresses.addSubnet(address,prefix,'ipv4');
for(const [address,prefix] of [['::',128],['::1',128],['fc00::',7],['fe80::',10]])localAddresses.addSubnet(address,prefix,'ipv6');
const localAddress=address=>isIP(address)!==0&&localAddresses.check(address,isIP(address)===6?'ipv6':'ipv4');

// Operator rules: exact origins, scheme/port-bound wildcard subdomains, or local
// HTTP(S) on any port. This is routing policy, not a kernel network sandbox.
export function createNavigationPolicy(origins=[],{resolve=lookup}={}){
  let allowLocal=false;const allowed=new Set(),wildcards=[];
  for(const value of origins){
    if(value==='local'){allowLocal=true;continue;}
    let u;try{u=new URL(value);}catch{throw copilotError('invalid_request');}
    if(!['http:','https:'].includes(u.protocol)||u.username||u.password||u.origin!==value)throw copilotError('invalid_request');
    if(u.hostname.includes('*')){
      const suffix=u.hostname.slice(2),labels=suffix.split('.');
      if(!u.hostname.startsWith('*.')||labels.length<2||labels.some(label=>! /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(label))||isIP(suffix))throw copilotError('invalid_request');
      wildcards.push({protocol:u.protocol,port:u.port,suffix:'.'+suffix});
    }else allowed.add(u.origin);
  }
  return async value=>{
    let u;try{u=new URL(value);}catch{throw copilotError('permission_denied');}
    if(!['http:','https:'].includes(u.protocol)||u.username||u.password)throw copilotError('permission_denied');
    const matched=allowed.has(u.origin)||wildcards.some(rule=>u.protocol===rule.protocol&&u.port===rule.port&&u.hostname.endsWith(rule.suffix));
    if(!matched&&!allowLocal)throw copilotError('permission_denied');
    const host=u.hostname.replace(/^\[|\]$/g,'');
    let addresses;try{addresses=isIP(host)?[{address:host}]:await resolve(host,{all:true});}catch{throw copilotError('permission_denied');}
    // Resolve afresh for every routed request. Mixed public/local DNS does not
    // qualify for local-only access. Chromium resolves independently (no DNS pin).
    if(!addresses.length||addresses.some(a=>!isIP(a.address))||!matched&&!addresses.every(a=>localAddress(a.address)))throw copilotError('permission_denied');
    return {url:u.href,private:addresses.some(a=>privateAddress(a.address))};
  };
}

export function createPlaywrightDriver({executablePath,allowedOrigins=[],headless=true}={}){
  let browser,browserPending;const contexts=new Map();const policy=createNavigationPolicy(allowedOrigins);
  async function capability(){
    if(!executablePath)return {available:false,reason:'executable_not_configured',driver:'playwright-core',version:'1.58.0'};
    try{await access(executablePath,constants.X_OK);const p=await import('playwright-core');if(!p.chromium)throw Error();return {available:true,driver:'playwright-core',version:'1.58.0',network:'operator-origin-allowlist',origins:[...allowedOrigins]};}
    catch{return {available:false,reason:'driver_unavailable',driver:'playwright-core',version:'1.58.0'};}
  }
  function target(session_id,target_id){const c=contexts.get(session_id);const t=c?.targets.get(target_id);if(!t||t.page.isClosed())throw copilotError('stale_resource');return t;}
  async function launch({session_id,url}){
    await policy(url);
    if(!(await capability()).available)throw copilotError('unavailable');
    if(!browser){browserPending??=(async()=>{const {chromium}=await import('playwright-core');return chromium.launch({executablePath,headless});})();try{browser=await browserPending;}catch(error){browserPending=null;throw error;}}
    const context=await browser.newContext({acceptDownloads:false,serviceWorkers:'block',viewport:{width:1000,height:700}});
    const c={context,targets:new Map()};contexts.set(session_id,c);
    await context.route('**/*',async route=>{try{await policy(route.request().url());await route.continue();}catch{await route.abort('blockedbyclient').catch(()=>{});}});
    await context.routeWebSocket('**/*',ws=>ws.close());
    context.on('page',page=>{
      const t={target_id:randomUUID(),page,refs:new Map()};c.targets.set(t.target_id,t);
      page.setDefaultTimeout(COPILOT_LIMITS.actionTimeoutMs);
      page.on('download',download=>download.cancel().catch(()=>{}));
      page.on('filechooser',chooser=>chooser.setFiles([]).catch(()=>{}));
      page.on('dialog',dialog=>dialog.dismiss().catch(()=>{}));
    });
    try{const page=await context.newPage();await page.goto(url,{waitUntil:'domcontentloaded',timeout:COPILOT_LIMITS.actionTimeoutMs});const t=[...c.targets.values()].find(t=>t.page===page);return await observe({session_id,target_id:t.target_id});}
    catch(error){await close({session_id});throw error;}
  }
  async function observe({session_id,target_id,preserve_refs=false}){
    const t=target(session_id,target_id);await policy(t.page.url());
    const observedUrl=t.page.url(),u=new URL(observedUrl);if(!preserve_refs){await Promise.all([...t.refs.values()].map(handle=>handle.dispose().catch(()=>{})));t.refs.clear();}const elements=[];
    const locators=t.page.locator('button, a[href], input:not([type="file"]):not([type="password"]), textarea, select, [role="button"], [role="link"], [role="textbox"]');
    const count=await locators.count();
    for(let i=0;i<Math.min(count,COPILOT_LIMITS.snapshotElements);i++){
      // Pin a DOM element handle, not an nth locator that could silently match a
      // replacement node after review. Detached handles fail rather than retarget.
      const locator=await locators.nth(i).elementHandle();if(!locator)continue;if(!await locator.isVisible()){await locator.dispose();continue;}
      const ref=`r${i}`;if(!preserve_refs)t.refs.set(ref,locator);
      const role=(await locator.getAttribute('role')||await locator.getAttribute('type')||'control').slice(0,80);
      const name=(await locator.getAttribute('aria-label')||await locator.getAttribute('placeholder')||await locator.textContent()||'').trim().slice(0,240);
      elements.push({ref,role,name});
      if(preserve_refs)await locator.dispose();
    }
    const text=(await t.page.locator('body').innerText()).slice(0,COPILOT_LIMITS.snapshotChars);
    const title=(await t.page.title()).slice(0,240);if(t.page.url()!==observedUrl)throw copilotError('stale_resource');
    return {target_id,url_hash:digest(observedUrl),origin:u.origin,display_url:u.origin+u.pathname,title,elements,text,truncated:count>COPILOT_LIMITS.snapshotElements,captured_at:Date.now()};
  }
  async function binding({session_id,target_id}){const t=target(session_id,target_id);await policy(t.page.url());return {url_hash:digest(t.page.url()),origin:new URL(t.page.url()).origin};}
  async function act({session_id,target_id,operation,expected_binding}){
    const t=target(session_id,target_id);
    const current=await binding({session_id,target_id});if(!expected_binding||current.origin!==expected_binding.origin||current.url_hash!==expected_binding.url_hash)throw copilotError('stale_resource');
    switch(operation.kind){
      case 'navigate':await policy(operation.url);await t.page.goto(operation.url,{waitUntil:'domcontentloaded',timeout:COPILOT_LIMITS.actionTimeoutMs});break;
      case 'snapshot':break;
      case 'click':case 'fill':{
        const locator=t.refs.get(operation.ref);if(!locator||!await locator.isVisible())throw copilotError('stale_resource');
        if(await locator.getAttribute('type')==='file'||await locator.getAttribute('type')==='password')throw copilotError('permission_denied');
        if(operation.kind==='click')await locator.click();else await locator.fill(operation.text);break;
      }
      case 'scroll':await t.page.mouse.move(500,350);await t.page.mouse.wheel(0,operation.dy);break;
      default:throw copilotError('unsupported');
    }
    // No neighbor fallback: a click closing this target must fail here.
    return observe({session_id,target_id});
  }
  async function screenshot(ids){const t=target(ids.session_id,ids.target_id);const bytes=await t.page.screenshot({type:'png',timeout:COPILOT_LIMITS.actionTimeoutMs});if(bytes.length>COPILOT_LIMITS.evidenceBytes)throw copilotError('limit_exceeded');return bytes;}
  async function targets({session_id}){const c=contexts.get(session_id);if(!c)throw copilotError('stale_resource');return [...c.targets.values()].map(t=>({target_id:t.target_id,closed:t.page.isClosed()}));}
  async function closeTarget(ids){await target(ids.session_id,ids.target_id).page.close();}
  async function close({session_id}){const c=contexts.get(session_id);contexts.delete(session_id);await c?.context.close();}
  return {capability,policy,launch,observe,binding,act,screenshot,targets,closeTarget,close,async shutdown(){await Promise.all([...contexts.keys()].map(session_id=>close({session_id})));await browser?.close();browser=null;browserPending=null;}};
}

export function resolveBrowserDriver({config=process.env}={}){
  return createPlaywrightDriver({executablePath:config.ORBIT_BROWSER_EXECUTABLE,allowedOrigins:(config.ORBIT_BROWSER_ALLOWED_ORIGINS||'').split(',').map(s=>s.trim()).filter(Boolean),headless:config.ORBIT_BROWSER_HEADLESS!=='0'});
}
