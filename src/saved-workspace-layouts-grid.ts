import {validateDockingPlacement, prunePlacement, emptyPlacement, type DockingPlacement, type PlacementNode, type PlacementDirection} from './docking-placement.ts';

/** Balanced binary splits keep depth bounded; untouched windows retain placement. */
export function compileDockingGrid(current:DockingPlacement, all:string[], ids:string[], columns:number):DockingPlacement {
  if(!ids.length||ids.length>100||new Set(ids).size!==ids.length||ids.some(id=>!all.includes(id))||!Number.isInteger(columns)||columns<1||columns>ids.length)throw Error('Invalid docking grid');
  const join=(nodes:PlacementNode[],direction:PlacementDirection):PlacementNode=>{if(nodes.length===1)return nodes[0];const middle=Math.floor(nodes.length/2);return {type:'branch',direction,ratio:middle/nodes.length,first:join(nodes.slice(0,middle),direction),second:join(nodes.slice(middle),direction)};};
  const rows:PlacementNode[]=[];for(let i=0;i<ids.length;i+=columns)rows.push(join(ids.slice(i,i+columns).map(id=>({type:'group',windows:[id]})),'horizontal'));
  const grid=join(rows,'vertical'),rest=prunePlacement(current??emptyPlacement(),all.filter(id=>!ids.includes(id)));
  return validateDockingPlacement({version:1,layout:rest.layout?{type:'branch',direction:'horizontal',ratio:0.75,first:grid,second:rest.layout}:grid,floats:rest.floats,active:ids[0]},{windowIds:all});
}
