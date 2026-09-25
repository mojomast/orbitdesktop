(function(root){
'use strict';
function auditGraph(nav,edges){
 const n=nav.length,invalid=[],asymmetric=[],adj=Array.from({length:n},()=>new Set());let links=0;
 edges.forEach((es,i)=>es.forEach(j=>{if(i>=n||!Number.isInteger(j)||j<0||j>=n){invalid.push({from:i,to:j});return;}links++;adj[i].add(j);adj[j].add(i);if(!edges[j]?.includes(i))asymmetric.push({from:i,to:j});}));
 const seen=new Set(),components=[];
 for(let i=0;i<n;i++){if(seen.has(i))continue;const nodes=[],q=[i];seen.add(i);while(q.length){const a=q.pop();nodes.push(a);for(const b of adj[a])if(!seen.has(b)){seen.add(b);q.push(b);}}components.push(nodes.sort((a,b)=>a-b));}
 return {nodes:n,directedLinks:links,components,isolatedNodes:components.filter(c=>c.length===1).flat(),invalidLinks:invalid,oneWayLinks:asymmetric,scope:'Weak graph connectivity only. One-way links may be intentional. No walkEdge, physics, player traversal or vehicle clearance approval.'};
}
function validateEvidence(v){
 if(!v||v.schema!=='cocs.diagnostics/v1'||!v.source||typeof v.source.commit!=='string'||!/^[a-f0-9]{40}$/.test(v.source.commit)||typeof v.source.branch!=='string'||!Array.isArray(v.results)||v.results.length>500)throw Error('Invalid diagnostic evidence schema or source');
 const names=new Set();for(const r of v.results){if(!r||typeof r.name!=='string'||!r.name||names.has(r.name)||!['pass','fail','unavailable'].includes(r.status))throw Error('Invalid or duplicate scenario result');names.add(r.name);}return v;
}
function compareEvidence(base,current){validateEvidence(base);validateEvidence(current);const a=new Map(base.results.map(r=>[r.name,r])),b=new Map(current.results.map(r=>[r.name,r]));return {baseline:base.source,current:current.source,sameCommit:base.source.commit===current.source.commit,sameBranch:base.source.branch===current.source.branch,trust:'Imported evidence is untrusted user-provided data, not independently verified execution or PR approval.',changes:[...new Set([...a.keys(),...b.keys()])].map(name=>{const before=a.get(name)?.status??'missing',after=b.get(name)?.status??'missing';return {name,before,after,regression:before==='pass'&&after!=='pass',improvement:before!=='pass'&&after==='pass'};})};}
root.cocsEvidenceTools={auditGraph,validateEvidence,compareEvidence};
})(globalThis);
