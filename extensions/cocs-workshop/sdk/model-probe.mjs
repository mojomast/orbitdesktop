// Trusted probe, bundled with the draft and run in an isolated browser, never Node.
import {vehicleModel,robotModel,weaponModel} from './game/view.mjs';
import {CHARACTERS,WEAPONS} from './game/data.mjs';
function inspect(root){
 const errors=[],nodes=new Set();let meshes=0,triangles=0;
 root.traverse(n=>{nodes.add(n);if(n.isMesh){meshes++;const p=n.geometry?.attributes?.position;if(!p)errors.push('Mesh without positions');else{triangles+=(n.geometry.index?.count||p.count)/3;for(let i=0;i<p.array.length;i++)if(!Number.isFinite(p.array[i])){errors.push('Non-finite geometry');break;}}}});
 const refs={},seen=new WeakSet();
 function walk(v,path,depth=0){if(depth>7||v==null)return;if(v.isObject3D){refs[path]={type:v.type,attached:nodes.has(v),parent:v.parent===root?'root':'nested'};if(!nodes.has(v))errors.push(path+': detached animation reference');return;}if(typeof v!=='object'||seen.has(v))return;seen.add(v);if(v.isMaterial||v.isBufferGeometry||v.isTexture)return;for(const [k,x]of Object.entries(v))walk(x,path+'.'+k,depth+1);}
 walk(root.userData,'userData');
 // Measure draw growth only in stationary branches, excluding every referenced moving subtree.
 const moving=new Set();for(const n of nodes){if(n===root)continue;let found=false;const scan=(v,seen=new WeakSet(),depth=0)=>{if(!v||typeof v!=='object'||depth>7||seen.has(v))return;seen.add(v);if(v===n){found=true;return;}if(v.isObject3D||v.isMaterial||v.isBufferGeometry||v.isTexture)return;for(const x of Object.values(v))scan(x,seen,depth+1);};scan(root.userData);if(found)moving.add(n);}
 let stationary=0;for(const n of nodes){if(!n.isMesh)continue;let p=n,dynamic=false;while(p&&p!==root){if(moving.has(p))dynamic=true;p=p.parent;}if(!dynamic)stationary++;}
 return {meshes,triangles,stationary,refs,errors};
}
export function probe(){const report={vehicles:{},characters:{},weapons:{}};
 for(const kind of ['puma','hornet']){const r=vehicleModel(kind),d=r.userData,p=inspect(r);p.contract={kind:d.kind,vehicle:d.vehicle,wheels:Array.isArray(d.wheels)?d.wheels.length:null,turret:d.turret===null?'null':d.turret?.isObject3D?'object':'invalid',guns:Array.isArray(d.guns)?d.guns.length:null,flashUntil:Number.isFinite(d.flashUntil)};if(d.kind!==kind||d.vehicle!==true||p.contract.wheels===null||p.contract.guns===null||!p.contract.flashUntil||p.contract.turret==='invalid')p.errors.push('Invalid vehicle userData contract');report.vehicles[kind]=p;}
 for(const c of CHARACTERS)report.characters[c.id]=inspect(robotModel(c.id));
 for(let i=0;i<WEAPONS.length;i++)report.weapons[i]=inspect(weaponModel(i));return report;}
window.probeResult=probe();
