import {test} from 'node:test';
import assert from 'node:assert/strict';
import {captureLayout} from '../src/layout-presets.ts';
import {initial,leaves} from '../src/model.ts';
import {importSavedLayoutAsWorkspaceRecipe} from '../src/workspace-recipe-import.ts';

const freeze=value=>{
  if(value&&typeof value==='object'&&!Object.isFrozen(value)){
    for(const child of Object.values(value))freeze(child);
    Object.freeze(value);
  }
  return value;
};
const binding=(id,pane_id,role)=>({id,pane_id,role});

function sourceLayout(workspace,name='Legacy arrangement'){
  const layout=captureLayout(workspace,name,'layout-id');
  return layout;
}

test('imports different projects as portable role order without exporting instance IDs',()=>{
  const workspace=initial(),panes=workspace.monitors.map(monitor=>leaves(monitor.layout)[0].id);
  const reversed=sourceLayout(workspace);
  reversed.windows.reverse();
  const normal=sourceLayout(workspace,'Another local arrangement');
  const firstBindings=[binding('binding-a1',panes[0],'active_terminal'),binding('binding-a2',panes[2],'project_files')];
  const secondBindings=[binding('binding-b1',panes[0],'active_terminal'),binding('binding-b2',panes[1],'candidate_diff')];
  const first=importSavedLayoutAsWorkspaceRecipe(reversed,workspace,firstBindings);
  const second=importSavedLayoutAsWorkspaceRecipe(normal,workspace,secondBindings);
  assert.deepEqual(first.definition,{name:'Legacy arrangement',roles:['project_files','active_terminal'],layout:'prioritize',renderer:'windows'});
  assert.deepEqual(second.definition,{name:'Another local arrangement',roles:['active_terminal','candidate_diff'],layout:'prioritize',renderer:'windows'});
  for(const output of [first,second]){
    const serialized=JSON.stringify(output);
    for(const identifier of [...workspace.monitors.map(monitor=>monitor.id),...panes,...firstBindings.map(item=>item.id),...secondBindings.map(item=>item.id),'layout-id'])
      assert.equal(serialized.includes(identifier),false,`portable output leaked ${identifier}`);
  }
  assert.deepEqual(first.absent_roles,['primary_agent','preview','candidate_diff']);
  assert.ok(first.omitted_fields.includes('frame pixel coordinates'));
  assert.ok(first.omitted_fields.includes('spatial camera position'));
  assert.match(first.warnings.join(' '),/preview.*durable recipe save/i);
});

test('ambiguous roles require a binding choice and reject choices from another project or role',()=>{
  const workspace=initial(),panes=workspace.monitors.map(monitor=>leaves(monitor.layout)[0].id);
  const saved=sourceLayout(workspace);
  const candidates=[binding('binding-one',panes[0],'active_terminal'),binding('binding-two',panes[1],'active_terminal')];
  assert.throws(()=>importSavedLayoutAsWorkspaceRecipe(saved,workspace,candidates),/ambiguous active_terminal/);
  const selected=importSavedLayoutAsWorkspaceRecipe(saved,workspace,candidates,{active_terminal:'binding-two'});
  assert.deepEqual(selected.definition.roles,['active_terminal']);
  assert.throws(()=>importSavedLayoutAsWorkspaceRecipe(saved,workspace,candidates,{active_terminal:'foreign-project-binding'}),/actual binding/);
  assert.throws(()=>importSavedLayoutAsWorkspaceRecipe(saved,workspace,candidates,{not_a_role:'binding-one'}),/unknown or malformed/);
});

test('missing roles are explicit and malformed or foreign pane relations fail closed',()=>{
  const workspace=initial(),pane=leaves(workspace.monitors[0].layout)[0].id,saved=sourceLayout(workspace);
  const result=importSavedLayoutAsWorkspaceRecipe(saved,workspace,[binding('binding-only',pane,'project_files')]);
  assert.deepEqual(result.definition.roles,['project_files']);
  assert.deepEqual(result.absent_roles,['primary_agent','active_terminal','preview','candidate_diff']);
  assert.throws(()=>importSavedLayoutAsWorkspaceRecipe(saved,workspace,[binding('foreign-pane-binding','pane-from-another-workspace','project_files')]),/does not exist/);
  assert.throws(()=>importSavedLayoutAsWorkspaceRecipe(saved,workspace,[binding('unknown-role-binding',pane,'invented_role')]),/not supported/);
});

test('adapter validates without mutating inputs and ignores stale saved windows without resurrecting them',()=>{
  const workspace=initial(),currentBefore=structuredClone(workspace),saved=sourceLayout(workspace);
  saved.windows=[{id:'stale-window-id'},...saved.windows.slice(0,1)];
  saved.view='spatial';saved.camera={x:0,y:0,z:0,azimuth:0,elevation:0,distance:10};
  const savedBefore=structuredClone(saved),bindings=[binding('binding-real',leaves(workspace.monitors[0].layout)[0].id,'project_files')],bindingsBefore=structuredClone(bindings);
  const output=importSavedLayoutAsWorkspaceRecipe(freeze(saved),freeze(workspace),freeze(bindings));
  assert.deepEqual(output.definition,{name:'Legacy arrangement',roles:['project_files'],layout:'prioritize',renderer:'spatial'});
  assert.ok(output.warnings.some(warning=>warning.includes('stale')));
  const serialized=JSON.stringify(output);
  for(const identifier of ['stale-window-id',...workspace.monitors.map(monitor=>monitor.id),...bindings.map(item=>item.id)])assert.equal(serialized.includes(identifier),false);
  assert.deepEqual(saved,savedBefore);assert.deepEqual(workspace,currentBefore);assert.deepEqual(bindings,bindingsBefore);
});

test('rejects invalid saved-layout identifiers, excess windows, and names outside durable recipe limits',()=>{
  const workspace=initial(),saved=sourceLayout(workspace),bindings=[];
  assert.throws(()=>importSavedLayoutAsWorkspaceRecipe({...saved,id:'bad/id'},workspace,bindings),/layout ID/);
  assert.throws(()=>importSavedLayoutAsWorkspaceRecipe({...saved,name:'x'.repeat(61)},workspace,bindings),/recipe name/);
  assert.throws(()=>importSavedLayoutAsWorkspaceRecipe({...saved,windows:Array.from({length:101},(_,index)=>({id:`window-${index}`}))},workspace,bindings),/window count/);
  assert.throws(()=>importSavedLayoutAsWorkspaceRecipe({...saved,windows:[saved.windows[0],saved.windows[0]]},workspace,bindings),/duplicated/);
});
