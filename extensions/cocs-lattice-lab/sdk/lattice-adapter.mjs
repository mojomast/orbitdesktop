import {cocsTemplate,capturableBy,connectedToHq,connectivityIncome,cutLink,repairLink,updateLiveNodes,enterEndgame,cocsSnapshot} from './game/cocs.mjs';
import {LATTICE_MAPS} from './game/lattice-maps.mjs';
import {directorPhase,directorRate,directorAccrue,directorCap} from './game/cocs-director.mjs';
import {COCS_TIERS,directorWavePlan,COOP_SINKS,COOP_PACING,DIRECTOR_TIERS} from './game/cocs-difficulty.mjs';
import {scoreEvent,SCORE_EVENTS,REQ_ITEMS} from './game/cocs-economy.mjs';
import {Match} from './game/core.mjs';
const arena=LATTICE_MAPS[0];
function create(mode='cocs'){return cocsTemplate(mode,arena,{mode});}
function inspect(state){const c=connectivityIncome(state);return {income:c.income,connected:c.connected,nodes:state.nodes.map(n=>({id:n.id,owner:n.owner,live:n.live,cut:state.cuts.includes(n.id),connected:connectedToHq(state,n.id),legal:[capturableBy(state,n.id,0),capturableBy(state,n.id,1)]}))};}
function director(tier,wave,seconds){const plan=directorWavePlan(wave,tier),length=(plan.timer||90)*60;const phase=directorPhase(seconds*60,length,false);return {plan,phase,rate:directorRate(tier,phase),cap:directorCap(tier),pressure:directorAccrue(0,directorRate(tier,phase),seconds,directorCap(tier)),note:'Isolated constant-current-phase budget probe; not total wave spending or full Director simulation.'};}
function smoke(){const s=create(),f=s.nodes.find(n=>n.id==='front-0');if(!f)throw Error('Authored front missing');if(!capturableBy(s,f.id,0))throw Error('Opening capture illegal');f.owner=0;updateLiveNodes(s);if(connectivityIncome(s).income[0]<=0)throw Error('Connected node earns no income');cutLink(s,f.id);if(connectedToHq(s,f.id))throw Error('Cut node remains connected');repairLink(s,f.id);if(!connectedToHq(s,f.id))throw Error('Repair did not reconnect');for(const t of COCS_TIERS)for(let w=1;w<=5;w++){const d=director(t,w,20);if(!Number.isFinite(d.rate)||!d.plan)throw Error('Invalid director plan');}return {ok:true,checks:['authored opening adjacency','connected income','cut and repair','D1–D4 wave plans'],source:'actual imported game functions; not full gameplay acceptance'};}
function match(mode='cocs',tier='D1'){let x=12345;return new Match('chatgpt','openclaw',()=>{x=(Math.imul(x,1664525)+1013904223)>>>0;return x/4294967296;},'lattice-slice',{mode,cocsTier:tier,botCount:0,humanCount:1,timeLimit:300});}
window.latticeSDK={create,inspect,director,scoreEvent,cutLink,repairLink,updateLiveNodes,enterEndgame,arena,COCS_TIERS,COOP_SINKS,COOP_PACING,DIRECTOR_TIERS,SCORE_EVENTS,REQ_ITEMS,match,cocsSnapshot,smoke};
window.probeResult=smoke();
