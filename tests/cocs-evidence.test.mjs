import assert from 'node:assert/strict';
import '../apps/cocs-studio/evidence-tools.js';
const {auditGraph,validateEvidence,compareEvidence}=globalThis.cocsEvidenceTools;
const g=auditGraph([{}, {}, {}, {}],[[1],[0,2,9],[],[]]);
assert.deepEqual(g.components,[[0,1,2],[3]]);assert.deepEqual(g.isolatedNodes,[3]);assert.equal(g.invalidLinks.length,1);assert.deepEqual(g.oneWayLinks,[{from:1,to:2}]);
const e={schema:'cocs.diagnostics/v1',source:{branch:'test',commit:'a'.repeat(40)},results:[{name:'route',status:'pass'}]};
assert.equal(validateEvidence(e),e);assert.throws(()=>validateEvidence({...e,results:[...e.results,...e.results]}));assert.throws(()=>validateEvidence({...e,source:{commit:'x'}}));
const c=compareEvidence(e,{...e,results:[{name:'route',status:'fail'},{name:'new',status:'pass'}]});assert(c.changes[0].regression);assert(c.changes[1].improvement);assert(compareEvidence(e,{...e,results:[]}).changes[0].regression);
console.log('PASS graph components, invalid/one-way links, isolated nodes, evidence validation, duplicate rejection, regressions and missing checks');
