// NIGHTSHIFT · relief plate. All dimensions below are drawing coordinates, never telemetry.
// Static metalwork and rails have no lifecycle. A station's little docket is its readout.
const NS = 'http://www.w3.org/2000/svg';
const PLATES = [
  ['auth','Authorization','Intake vault',111,119],
  ['dispatch','Dispatch','Dispatch transmitter',315,110],
  ['build','Build','Fabrication gantry',520,101],
  ['verify','Verify','Verification optics',725,92],
  ['review','Review','Review lens',783,326],
  ['integrate','Integrate','Integration press',578,335],
  ['deploy','Deploy','Deploy tower',373,344],
  ['receiver','Receiver','Receiver aperture',168,353],
];
const CAP = 30;
let instance = 0;
const path = (parent,d,attrs) => el(parent,'path',{d,...attrs});
function el(parent,tag,attrs = {},content) {
  const child = parent.ownerDocument.createElementNS(NS,tag);
  for (const [key,value] of Object.entries(attrs)) child.setAttribute(key,value);
  if (content !== undefined) child.textContent = content;
  parent.appendChild(child);
  return child;
}
function set(node,name,value) { if(node.getAttribute(name)!==String(value)) node.setAttribute(name,value); }
function text(node,value) { if(node.textContent!==value) node.textContent=value; }
const use = (parent,id,attrs) => el(parent,'use',{href:'#'+id,...attrs});
const line = (p,d,stroke,width=1,attrs={}) => path(p,d,{fill:'none',stroke,'stroke-width':width,...attrs});
const shape = (p,d,fill,attrs) => path(p,d,{fill,...attrs});
const label = (p,x,y,cls,txt) => el(p,'text',{x,y,class:cls},txt);
const poly = points => 'M'+points.map(([x,y])=>`${x},${y}`).join('L')+'Z';
const xlate = (x,y) => `translate(${x} ${y})`;
const multiple = (n,fn) => Array.from({length:n},(_,i)=>fn(i)).join('');

// Local axonometric bench coordinates. Tall parts occlude their own rear machining,
// while the short platen remains visible in front. No raster/filter dependency.
const face = (x,y,z=0) => [x*.9-y*.78,x*.32+y*.43-z].map(v=>Math.round(v*100)/100);
function slab(p,x,y,w,l,base,h,mat) {
  const a=face(x,y,base+h),b=face(x+w,y,base+h),c=face(x+w,y+l,base+h),d=face(x,y+l,base+h);
  const B=face(x+w,y,base),C=face(x+w,y+l,base),D=face(x,y+l,base);
  shape(p,poly([b,B,C,c]),mat[2]); shape(p,poly([d,c,C,D]),mat[1]);
  shape(p,poly([a,b,c,d]),mat===iron?'inherit':mat[0],{stroke:mat[3],'stroke-width':.62,'stroke-linejoin':'round'});
}
const iron = ['#607b7b','#324d51','#1c3239','#a1b6af'];
const steel = ['#adb9ab','#647971','#394f50','#d0d6c3'];
const bronze = ['#caaa70','#927444','#5b5038','#e4c591'];
const enamel = ['#7faaa2','#446d69','#294e50','#b3d6c8'];
const HEX='M-82 -6 -38 -33 45 -29 82 -3 38 26 -44 22Z';
const PERIM='M-88 -7 -40 -38 47 -34 88 -4 39 31 -46 27Z';
function ramp(defs,id,colors) {
  const g=el(defs,'linearGradient',{id,x1:'5%',y1:'0%',x2:'90%',y2:'100%'});
  for (const [offset,color] of colors) el(g,'stop',{offset,'stop-color':color});
}
function definitions(defs,ns) {
  ramp(defs,ns+'machined',[[0,'#b1c3b4'],['24%','#819c91'],['100%','#486466']]);
  ramp(defs,ns+'deck',[[0,'#88a09a'],['18%','#597977'],['68%','#3e585a'],['100%','#304747']]);
  ramp(defs,ns+'wall',[[0,'#506863'],['35%','#2e4646'],['95%','#182d30']]);
  ramp(defs,ns+'lens',[[0,'#bfdfdf'],['27%','#8faebd'],['38%','#427084'],['72%','#293f56'],['100%','#152c36']]);
  const grid=el(defs,'pattern',{id:ns+'grid',width:72,height:36,patternUnits:'userSpaceOnUse'});
  line(grid,'M0 0 72 36M72 0 0 36','#354849',.45);
  const hatch=el(defs,'pattern',{id:ns+'hatch',width:5,height:5,patternUnits:'userSpaceOnUse'});
  shape(hatch,'M0 0H5V5H0Z','#253032');line(hatch,'M-1 1 1 -1M0 5 5 0M4 6 6 4','#99a4a1',1.25);
  const pad=el(defs,'g',{id:ns+'pad'});
  shape(pad,HEX,'#0a1113',{transform:'translate(6 18)'});
  shape(pad,HEX,'#233539',{transform:'translate(0 15)'});
  shape(pad,'M-82 -6 -44 22 38 26V37L-44 33 -82 5Z',`url(#${ns}wall)`);
  shape(pad,'M38 26 82 -3V8L38 37Z','#243537');
  line(pad,'M-82 2 -44 30 38 34 82 5','#6c7973',.8);
  shape(pad,HEX,`url(#${ns}deck)`,{stroke:'#849991','stroke-width':1});
  line(pad,'M-73 -6 -37 -28 43 -24 73 -3 37 20 -42 16Z','#94a8a1',.8);
  line(pad,'M-66 -6 -47 8 -32 9M46 -20 64 -8M51 8 37 17 18 16','#b1c4b7',1.1);
  line(pad,multiple(14,i=>`M${-38+i*5} ${24+(i*5)*.05}v4`),'#182b2c',1.7);
  line(pad,'M-62 0l7 5m2-6 7 5m77-23 10 1m6 1 5 3M-63 -8l8-5 6 .3m-5 6 7-4M12 17l8 .5m-12-3 16 1','#263f42',1.1);
  shape(pad,'M-70 -7l3-2 4 1-3 2ZM65 -5l3-2 4 1-3 2ZM-40 12l3-2 4 1-3 2ZM35 17l3-2 4 1-3 2Z','#d0cbb2');
  // Punched badges. Broad, deployed wings for in-flight observations; a
  // folded pair for filed/held receipts. Code and silhouette survive grayscale.
  // Reuse the dies (including lettering), rather than duplicating DOM per badge.
  const swept='M-2 0Q-13 -13 -14 -6Q-14 0 -3 4ZM2 0Q13 -13 14 -6Q14 0 3 4Z';
  const blunt='M-2 0 -12 -8 -14 -3 -10 1 -3 4ZM2 0 12 -8 14 -3 10 1 3 4Z';
  const folded='M-2 -4Q-11 -5 -8 3L-3 8 -2 2ZM2 -4Q11 -5 8 3L3 8 2 2Z';
  const body='M-2 -5 -4 -10 -1 -7Q0 -9 1 -7L4 -10 2 -5Q5 -3 3 0L3 4 0 9 -3 4 -3 0Q-5 -3 -2 -5ZM-2 1H2v1h-4Zm.5 3h3v1h-3Z';
  for(const [id,wings,code] of [['flight0',swept,'IN'],['flight1',blunt,'IN'],['filed',folded,'END'],['failed',folded,'ERR'],['held',folded,'WAIT'],['last',folded,'OLD'],['gap','M-3 -6 -9 -8 -11 -4 -5 1ZM3 0 8 2 9 6 3 5Z','?']]) {
    const die=el(defs,'g',{id:ns+id});
    shape(die,wings,'var(--hs-wing)',{transform:'translate(-6 0)'});
    shape(die,body,'var(--hs-body)',{transform:'translate(-6 0)','fill-rule':'evenodd'});
    label(die,12,4,'hs-code',code).setAttribute('text-anchor','middle');
  }
}

// A cylinder with a turned rim and a single specular land. Used on bearings, not as an icon.
function drum(p,x,y,rx,ry,h,wall,cap) {
  shape(p,`M${x-rx} ${y-h}a${rx} ${ry} 0 0 0 ${2*rx} 0v${h}a${rx} ${ry} 0 0 1 ${-2*rx} 0Z`,wall);
  el(p,'ellipse',{cx:x,cy:y-h,rx,ry,fill:cap,stroke:'#a1b1ab','stroke-width':.8});
}
function vault(p) {
  slab(p,-33,-25,62,47,0,5,iron);
  slab(p,-31,-18,57,34,5,27,iron);
  // Recessed armored door in the near face; crossbar, rivets and machined dial.
  const d=el(p,'g',{transform:'matrix(.9 .32 0 1 -12.48 6.88)'});
  shape(d,'M-25 -29H20l3 3v17h-48Z','#13282c',{stroke:'#98aaa1','stroke-width':1.1});
  shape(d,'M-21 -26h39v15h-39Z','#5a766e');
  line(d,'M-19 -22h31M-18 -15H8','#273f41',2);
  el(d,'circle',{cx:1,cy:-18,r:7,fill:'#263739',stroke:'#c1b48d','stroke-width':2});
  line(d,'M1 -24v12M-4 -21l10 6m0-6-10 6','#c7b98f',1.8);
  slab(p,-29,-16,14,29,32,4,enamel);slab(p,9,-16,14,29,32,4,enamel);
  line(p,'M-4 -40 7 -36 13 -40 2 -44Z','#c5ba99',1.2);
}
function transmitter(p) {
  slab(p,-24,-21,48,42,0,5,iron);drum(p,2,0,16,7,6,'#384e4d','#6b857f');
  shape(p,'M-10 -7 -4 -27 3 -26 8 -8 0 -5Z','#83938a');
  shape(p,'M1 -8 -2 -23 3 -26 8 -8Z','#374d50');
  const dish=el(p,'g',{transform:'translate(-1 -31) rotate(-28)'});
  shape(dish,'M-29 -3Q-25 14 0 16Q24 12 29 -3Z','#495e5c');
  el(dish,'ellipse',{cy:-3,rx:30,ry:11,fill:'#839e93',stroke:'#bdcaba','stroke-width':1.4});
  line(dish,'M-24 -6Q-16 2 2 4Q15 4 25 -1M-15 -10Q-7 0 2 4Q5 -3 10 -11M-2 -13 2 4','#536e66',.9);
  line(dish,'M-26 -4 -4 -22 23 -8M2 4 -4 -22','#c3c8ac',1.25);
  shape(dish,'M-8 -23 -5 -25 0 -23 -2 -20Z','#d4b77d');
  slab(p,17,9,9,13,5,8,bronze);
}
function gantry(p) {
  // Cast bed, two parallel ways, offset bridge with hanging tool carriage.
  slab(p,-36,-24,74,49,0,5,iron);
  for (const y of [-20,13]) slab(p,-34,y,69,7,5,5,steel);
  slab(p,-8,-10,22,23,5,4,enamel);
  slab(p,24,-23,9,9,9,42,bronze);
  slab(p,-29,9,10,12,9,42,bronze);
  slab(p,-31,-19,65,14,49,9,bronze);
  slab(p,-30,-15,8,36,48,9,bronze);
  const beam=el(p,'g',{transform:'matrix(.9 .32 0 1 3.9 -2.15)'});
  shape(beam,'M-27 -56H31v5h-58Z','#665a44');
  line(beam,'M-26 -51l6-5 6 5 6-5 6 5 6-5 6 5 6-5 6 5 5-5','#d3bb84',1.2);
  slab(p,-1,-17,14,17,47,15,iron); drum(p,6,-30,4,1.8,14,'#b3bcb1','#cdd3c0');
  shape(p,'M2 -30l4 9 4-9Z','#b19765');
  line(p,'M-32 -7v-18q0-6 5-5l4 2','#b7b5a2',1.3);
}
function optics(p,ns) {
  // A three-axis optical comparator: bored instrument tube on a fork, optical
  // elements inset in the viewer-facing barrel; short calibrated reference bed.
  slab(p,-30,-21,56,41,0,5,iron); drum(p,0,-2,13,5,5,'#566d74','#9aaab0');
  shape(p,'M-6 -6 -9 -31 -1 -38 9 -32 7 -7 2 -5Z','#586f7d');
  line(p,'M-5 -8 -7 -29 0 -33','#b8c7c8',2);
  const barrel=el(p,'g',{transform:'translate(0 -32) rotate(-25)'});
  shape(barrel,'M-28 -11Q-35 0 -28 11L23 14Q33 1 23 -14Z','#465e6d');
  shape(barrel,'M-26 -10 23 -13 23 -6 -28 -4Z','#99a9aa');
  line(barrel,'M-21 -10Q-28 0 -21 11m5-21q-7 10 0 21m28-24q-9 14 0 26','#273e4a',2.2);
  el(barrel,'ellipse',{cx:23,rx:8.5,ry:14,fill:'#263942',stroke:'#b5c2c2','stroke-width':1.6});
  el(barrel,'ellipse',{cx:24,rx:5.3,ry:10.7,fill:`url(#${ns}lens)`});
  line(barrel,'M26 -8q-5 2-5 9','#b4d9e3',1.05);
  slab(p,13,12,16,9,5,5,steel);
}
function review(p,ns) {
  slab(p,-27,-21,54,44,0,4,iron);
  slab(p,-15,-5,29,23,4,2,steel);
  line(p,'M-20 -3 -4 2m-12-4 17 5m-11-1 7 3','#546866',1.1);
  drum(p,18,-3,8,3.5,5,'#5f6354','#a5aa94');
  line(p,'M17 -8 20 -29 8 -40 -2 -40','#243c41',7);
  line(p,'M16 -8 19 -29 8 -38 -2 -38','#c1bda2',3.5);
  const ring=el(p,'g',{transform:'translate(-10 -37) rotate(-19)'});
  el(ring,'ellipse',{cy:3,rx:24,ry:17,fill:'#454b42',stroke:'#8c8f79'});
  el(ring,'ellipse',{rx:24,ry:17,fill:'#b8ac89',stroke:'#d6ccab','stroke-width':1.2});
  el(ring,'ellipse',{rx:19,ry:12.6,fill:`url(#${ns}lens)`,stroke:'#374d4f','stroke-width':2});
  line(ring,'M-15 -1q3-8 15-9m-2 6v8m-5-4h10','#c3d9d5',1);
}
function press(p) {
  slab(p,-27,-23,55,46,0,7,iron);
  slab(p,14,-19,9,33,7,38,enamel);
  slab(p,-25,-18,9,31,7,38,enamel);
  slab(p,-15,-6,27,20,7,5,steel);
  drum(p,0,-17,6,2.5,18,'#a0afa8','#ced3c3');slab(p,-11,-8,24,17,15,5,steel);
  slab(p,-29,-21,58,37,44,11,enamel);slab(p,-21,-18,41,24,55,4,iron);
  line(p,'M-30 -42l5 2m1 0 5 2m1 0 5 2','#d8b674',2.8);
  line(p,'M-34 -2v-26l2-3v-8','#b6c2b2',1.8);
}
function tower(p) {
  slab(p,-23,-20,47,40,0,5,iron);
  slab(p,-11,-10,23,21,5,28,iron);
  line(p,'M-19 -7 -15 -30 -3 -6 -3 -32 12 -5 13 -30 19 -8','#98a8a0',2);
  slab(p,-19,-16,39,33,32,4,steel);
  slab(p,-11,-9,20,18,36,23,enamel);
  line(p,'M-13 -40 -6 -37m-7-8 7 3m-7-8 7 3m-7-8 7 3','#273e41',1.8);
  slab(p,-14,-11,28,22,59,4,steel);drum(p,1,-62,5,2,6,'#947b54','#c9b087');
  line(p,'M1 -68v-15m-5 12 10-3M13 -7v-21l-3-2v24m0-20 3 1m-3 4 3 1m-3 4 3 1m-3 4 3 1','#b8c3b8',1.55);
}
function receiver(p) {
  // Cast annular receiver well. The six machined shutter leaves are a fixed part,
  // never an opening animation or a proxy for a human receipt.
  drum(p,0,0,34,18,10,'#4a594f','#a0a38b');drum(p,0,-10,31,16,6,'#566257','#adae91');
  const well=el(p,'g',{transform:'translate(0 -17) scale(1 .54)'});
  el(well,'circle',{r:26,fill:'#1d3233',stroke:'#615c4a','stroke-width':2.5});
  for(let i=0;i<6;i++) shape(well,'M-2 -24Q12 -25 20 -14L7 5 8 -5Z',i%2?'#8e9e8e':'#72897f',{transform:`rotate(${i*60})`,stroke:'#344b47','stroke-width':.65});
  line(p,'M-30 -4v5m4-3v6m43-5v6m4-9v6','#a2a38b',1.8);
}
const ASSEMBLIES=[vault,transmitter,gantry,optics,review,press,tower,receiver];
const CASTS=[
  'M-40 0 -5 -23 41 -14 53 -4 18 16 -15 14Z',
  'M-31 1 -8 -13 20 -13 38 -17 49 -17 55 -12 51 -7 30 -3 32 5 0 16Z',
  'M-42 -4 -24 -15 26 -20 35 -17 49 -17 58 -9 39 1 43 7 0 18Z',
  'M-36 -1 -8 -13 28 -12 44 -20 55 -17 58 -8 47 -1 31 1 29 8 1 18Z',
  'M-36 0 -13 -14 0 -13Q5 -25 24 -23Q47 -22 41 -11L31 -5 35 4 4 18Z',
  'M-41 0 -21 -12 17 -20 49 -11 55 -6 32 3 34 8 0 18Z',
  'M-33 1 -13 -10 10 -11 27 -22 42 -24 45 -19 31 -10 37 -4 28 6 0 17Z',
  'M-30 -7Q-9 -22 24 -15Q65 -5 37 11Q11 26 -22 13Z',
];

function cartography(svg,ns) {
  const g=el(svg,'g',{'aria-hidden':'true',class:'hs-map'});
  shape(g,'M0 0H900V470H0Z','#141d22');shape(g,'M0 0H900V470H0Z',`url(#${ns}grid)`);
  // Survey bench cuts: nested contours share the overburden and the cut faces of
  // one landform, rather than a generic repeating field behind eight icons.
  const cuts=[
    'M-98 24 -44 52 35 54 76 30 154 33 185 16 263 19 303 -5',
    'M-88 239 -9 243 37 220 87 222 126 202 208 205 255 177 327 180 364 156',
    'M245 458 311 427 397 430 443 402 532 406 583 377 656 381 699 355 788 360 843 327 944 331',
    'M640 -29 705 4 763 6 810 30 851 30 905 60 956 62',
    'M669 211 707 190 747 192 788 170 833 173 890 143 946 147',
  ];
  const strips=cuts.map((d,i)=>multiple(6,k=>d.replace(/(-?\d+) (-?\d+)/g,(_,x,y)=>`${Number(x)+k*3} ${Number(y)+k*(i%2?5:4)}`))).join('');
  line(g,strips,'#273438',.8);line(g,cuts.join(''),'#334246',1);
  // Twin track: ballast shadow, web, transverse ties, crown and recessed flangeway.
  const track='M-24 121 111 126 166 107 231 110 259 96 315 117 374 96 438 99 472 82 520 108 581 86 646 89 678 73 725 99 816 103 861 131 861 244 809 276 783 333 722 353 656 350 624 365 578 342 518 363 447 360 416 377 373 351 314 373 242 370 214 386 168 360 97 388 -22 382';
  line(g,track,'#0d1619',15,{transform:'translate(1 3)'});
  line(g,track,'#526564',8);line(g,track,'#293c40',6.2);
  line(g,track,'#899088',7.8,{'stroke-dasharray':'1 7'});line(g,track,'#1a2a2e',3.4);
  // Stroke direction markers are fixed drafting arrows, not moving parcels.
  line(g,'M207 103l5 4-5 3m205-15 5 4-5 3m207-16 5 4-5 3m234 68 3 5 3-5m-178 191-6 3 5 4m-205 0-6 3 5 4m-205 1-6 3 5 4','#a5afa3',1.55);
  const crosses=[[27,31],[873,31],[27,386],[873,386],[232,54],[681,218],[74,260],[445,381]];
  line(g,crosses.map(([x,y])=>`M${x-4} ${y}h8m-4-4v8`).join(''),'#6c7c77',.8);
  line(g,multiple(43,i=>`M${30+20*i} 7v${i%5?2:5}`)+multiple(19,i=>`M8 ${27+20*i}h${i%5?2:5}`),'#61716c',.8);
  label(g,43,34,'hs-survey','H / 08    ·    AXONOMETRIC PLAN');
  label(g,728,434,'hs-survey','SECTION   A—A′');
  line(g,'M817 430h38m-37-2v4m12-4v4m12-4v4m12-4v4','#9ca69b',1);
}

function station(svg,plate,i,ns) {
  const [id,name,machine,x,y]=plate;
  const node=el(svg,'g',{transform:xlate(x,y),class:'hs-station',role:'button',tabindex:0,'data-kind':'station','data-id':id,'data-station':id});
  const title=el(node,'title');
  // Transparent hit area is restricted to this assembly and its docket.
  shape(node,'M-85 -47h50v-38h70v38h50V80H-85Z','transparent');
  const g=el(node,'g',{'aria-hidden':'true',fill:`url(#${ns}machined)`});
  use(g,ns+'pad');line(g,PERIM,'none',1.8,{class:'hs-outline'});
  shape(g,CASTS[i],'#172b2d',{'fill-opacity':.75});
  ASSEMBLIES[i](g,ns);
  shape(g,'M-79 -2 -45 23.5 -16 25v5l-29-1.5 -34-25.5Z',`url(#${ns}hatch)`,{class:'hs-hatching'});
  // The face-mounted tracer is the only metalwork coloured by observations.
  line(g,'M-13 28 15 29.5', 'currentColor',2.2,{class:'hs-signal-land'});
  const box=el(g,'g',{transform:'translate(-79 46)'});
  shape(box,'M0 0h156l5 5v29H0Z','#142024',{class:'hs-docket'});
  line(box,'M0 1h17','#8ba098',1.1);
  label(box,1,15,'hs-number',String(i+1).padStart(2,'0'));
  label(box,23,15,'hs-name',name);
  const depth=label(box,158,15,'hs-depth','');depth.setAttribute('text-anchor','end');
  const readout=label(box,1,30,'hs-reading','');
  return {node,title,depth,readout,id,name,machine};
}

function value(v,fallback='unknown') { return typeof v==='string'&&v.trim()?v.trim():fallback; }
function clipped(s,n) { return s.length<=n?s:s.slice(0,n-1).trimEnd()+'…'; }
function uncertain(quality) { return !['known','ok','live','measured','fresh','observed'].includes(quality); }

const TERMINAL=new Set(['succeeded','failed','cancelled','accepted','rejected','done']);
const IN_FLIGHT=new Set(['starting','running','working','backoff']);
const WAITING=new Set(['queued','blocked','not_started']);
function posture(state,quality,historical) {
  if(TERMINAL.has(state)) return state==='failed'||state==='rejected'?'failed':'filed';
  if(historical||quality==='stale')return 'last';
  if(uncertain(quality))return 'gap';
  if(IN_FLIGHT.has(state))return 'flight';
  return WAITING.has(state)?'held':'gap';
}
const POSTURE_NAME={flight:'In flight',held:'Waiting',filed:'Terminal record',failed:'Terminal failure record',last:'Last observed; current state unknown',gap:'Current state unconfirmed'};
const BADGE={
  flight:'M-24 -12H18l6 6v12l-6 6h-42Z',
  filed:'M-23 -10H18l5 5v15h-46Z',
  held:'M-23 -10H21v20h-44Z',
  last:'M-23 -10H18l5 5v15h-46Z',
  gap:'M-17 -11H17l6 6v10l-6 6h-34l-6-6V-5Z',
  failed:'M-23 -10H18l5 5v15h-46Z',
};

function updateStation(s,row,selection) {
  const quality=value(row?.quality),level=value(row?.level),gap=uncertain(quality)||level==='unknown';
  const depth=Number.isSafeInteger(row?.depth)&&row.depth>=0?row.depth:null;
  const signal=value(row?.signal), count=depth!==null?`Q ${depth}`:'';
  // The adapter owns level. It is only used as an allowlisted paint token.
  const tone=level==='danger'?'failure':['active','pressure','gate','verified','failure','delay','blocked','unknown'].includes(level)?level:'neutral';
  const readable=`${s.name}. ${s.machine}. ${signal}. Queue depth ${depth??'unknown'}. Quality ${quality}.`+(s.id==='build'?' The Build dock indexes observed execution identities. Dispatch and stage attribution are unproven.':'');
  set(s.node,'data-tone',tone); set(s.node,'data-gap',gap); set(s.node,'aria-label',readable);
  set(s.node,'aria-pressed',selection?.kind==='station'&&selection.id===s.id);
  set(s.node,'data-object-station',!!selection&&selection.kind!=='station'&&selection.stage===s.id);
  text(s.title,readable);
  text(s.depth,count);
  const notes=gap&&quality!=='unknown'&&uncertain(quality)?quality:'';
  const main=signal==='unknown'?'Unknown':signal;
  text(s.readout,[clipped(main,Math.max(9,27-notes.length)),notes].filter(Boolean).join(' · '));
}

function byID(rows) {
  const result=new Map();
  if (Array.isArray(rows)) for(const row of rows) {
    if(typeof row?.id==='string'&&row.id.trim()&&!result.has(row.id)) result.set(row.id,row);
  }
  return result;
}
const cmp=(a,b)=>a<b?-1:a>b?1:0;
export function createScene(container,{onSelect}={}) {
  const ns=`hs-${++instance}-`, doc=container.ownerDocument;
  const svg=el(container,'svg',{viewBox:'0 0 900 470',class:'hive-scene',role:'group','aria-label':'Production line. Use arrow keys to focus a station; Enter or Space to inspect.'});
  definitions(el(svg,'defs'),ns);cartography(svg,ns);
  const stations=PLATES.map((p,i)=>station(svg,p,i,ns));
  const register=el(svg,'g',{'aria-hidden':'true',class:'hs-register'});
  shape(register,'M15 202H883v50H21l-6-6Z','#101a1e',{stroke:'#516661','stroke-width':1});
  line(register,'M23 204h87m4 0h17M158 203v47M871 249h9','#81978c',1);
  label(register,24,219,'hs-register-label','BUILD DOCK');
  label(register,24,234,'hs-register-note','Execution identities');
  label(register,24,247,'hs-register-note','Dispatch link unproven');
  const detached=label(svg,22,456,'hs-register-label','');
  const legend=label(svg,22,456,'hs-die-key','');
  set(register,'visibility','hidden');
  const layer=el(svg,'g',{'aria-label':'Recorded attempt identities',role:'group'});
  const marks=new Map(), bindings=[];
  let disposed=false, hydrated=false, lastChanges=null;
  const reduced=doc.defaultView?.matchMedia?.('(prefers-reduced-motion: reduce)');
  function bind(node,kind,id,neighbor) {
    const select=()=>{ if(!disposed) onSelect?.({kind,id}); };
    const keys=e=>{
      if (e.altKey||e.ctrlKey||e.metaKey||e.shiftKey) return;
      if (e.key==='Enter'||e.key===' ') {e.preventDefault();if(!e.repeat)select();return;}
      if (['ArrowLeft','ArrowRight','ArrowUp','ArrowDown','Home','End'].includes(e.key)) {
        e.preventDefault(); neighbor(e.key)?.focus();
      }
    };
    node.addEventListener('click',select);node.addEventListener('keydown',keys);
    return ()=>{node.removeEventListener('click',select);node.removeEventListener('keydown',keys);};
  }
  for(const [i,s] of stations.entries()) {
    bindings.push(bind(s.node,'station',s.id,key=>{
      const reversed=i>=4;
      if(key==='Home')return stations[0].node;
      if(key==='End')return stations[7].node;
      if((key==='ArrowDown'&&!reversed)||(key==='ArrowUp'&&reversed))return stations[7-i].node;
      const step=key==='ArrowRight'?1:key==='ArrowLeft'?-1:0;
      return stations[Math.max(reversed?4:0,Math.min(reversed?7:3,i+step*(reversed?-1:1)))].node;
    }));
    updateStation(s,null,null);
  }
  function newMark(id,slot) {
    const node=el(layer,'g',{class:'hs-worker','data-id':id,'data-attempt':id,'data-kind':'attempt',tabindex:0,role:'button'});
    const title=el(node,'title');
    const land=shape(node,BADGE.gap,'#203032',{class:'hs-worker-land'});
    let die=0;for(const char of id)die=(Math.imul(31,die)+char.codePointAt(0))>>>0;
    const badge=use(node,ns+'gap',{'pointer-events':'none'});
    const unbind=bind(node,'attempt',id,key=>{
      const current=marks.get(id);
      const group=[...marks.values()].filter(other=>other.dock===current.dock).sort((a,b)=>a.slot-b.slot);
      const at=group.indexOf(current), width=current.dock==='build'?15:30;
      const target=key==='Home'?0:key==='End'?group.length-1:at+({ArrowLeft:-1,ArrowRight:1,ArrowUp:-width,ArrowDown:width}[key]||0);
      if(target<0&&key==='ArrowUp'&&current.dock==='build')return stations[2].node;
      return group[Math.min(group.length-1,Math.max(0,target))]?.node;
    });
    return {node,title,land,badge,die:die%2,slot,unbind,dock:null};
  }
  function update(view,selection,options={}) {
    if(disposed)return;
    const rows=byID(view?.stations), attempts=byID(view?.attempts);
    const historical=container.classList?.contains('historical')||['stale','unavailable'].includes(view?.health)||value(view?.health).startsWith('recorded')||options.historical===true;
    const moving=!historical&&!doc.hidden&&options.motion===true&&!reduced?.matches;
    const flash=hydrated&&moving&&options.changedIds instanceof Set&&options.changedIds!==lastChanges;
    // changedIds is the transport's result from confirmedChanges. Its keys
    // belong to attempts, not stations (their public IDs can collide).
    const maybeFlash=(record,id,eligible)=>{
      if(!moving||!eligible)record.pulse?.cancel();
      if(flash&&eligible&&options.changedIds.has(id)) {
        record.pulse?.cancel();
        record.pulse=record.land.animate?.([{stroke:'#d9fff0',strokeWidth:3},{stroke:'#9ccab8',strokeWidth:1.5}],{duration:440,easing:'ease-out',iterations:1});
      }
    };
    for(const s of stations){
      updateStation(s,rows.get(s.id),selection);
    }
    // Preserve visible identities and their physical slots. Fill free slots in
    // immutable-ID order. A selected off-plate receipt displaces one unselected
    // marker, rather than silently binding the inspector to a different worker.
    const sorted=[...attempts.keys()].sort(cmp);
    const visible=new Set([...marks.keys()].filter(id=>attempts.has(id)));
    for(const id of sorted) { if(visible.size===CAP)break;visible.add(id); }
    if(selection?.kind==='attempt'&&attempts.has(selection.id)&&!visible.has(selection.id)) {
      const evict=[...visible].reverse().find(id=>marks.get(id)?.node!==doc.activeElement)??[...visible].at(-1);
      visible.delete(evict);visible.add(selection.id);
    }
    for(const [id,r] of marks) if(!visible.has(id)) {
      if(doc.activeElement===r.node)stations[r.dock==='build'?2:0].node.focus();
      r.unbind();r.pulse?.cancel();r.node.remove();marks.delete(id);
    }
    const used=new Set([...marks.values()].map(r=>r.slot));
    let build=0,other=0;
    const badges=new Set();
    for(const id of visible) {
      const row=attempts.get(id), staged=row.stage==='build';
      let r=marks.get(id);
      if(!r) {let slot=0;while(used.has(slot))slot++;used.add(slot);r=newMark(id,slot);marks.set(id,r);}
      if(staged)build++;else other++;
      r.dock=staged?'build':'register';
      const x=staged?188+(r.slot%15)*47.5:163+r.slot*24;
      const y=staged?214+Math.floor(r.slot/15)*25:452;
      set(r.node,'transform',xlate(x,y)+(staged?' scale(.94 1)':' scale(.48 .82)'));
      const quality=value(row.quality), state=value(row.state), stage=value(row.stage), route=value(row.route);
      const mode=posture(state,quality,historical);
      const location=staged?'Build dock. Dispatch and stage attribution unproven.':`Stage ${stage}.`;
      const name=`Attempt ${id}. ${POSTURE_NAME[mode]}. ${location} State ${state}. Route ${route}. Quality ${quality}.`+(historical?' Historical view.':'');
      text(r.title,name);set(r.node,'aria-label',name);set(r.node,'aria-pressed',selection?.kind==='attempt'&&selection.id===id);
      const gap=uncertain(quality)||mode==='gap'||historical;
      set(r.node,'data-gap',gap);set(r.node,'data-posture',mode);
      set(r.node,'data-related',!!selection&&options.relatedIds instanceof Set&&options.relatedIds.has(id));
      set(r.land,'d',BADGE[mode]);set(r.badge,'href','#'+ns+mode+(mode==='flight'?r.die:''));
      badges.add(mode);maybeFlash(r,id,!gap);
    }
    const total=attempts.size, overflow=total>CAP?` · ${CAP}/${total} SHOWN`:'';
    set(register,'visibility',build?'visible':'hidden');
    text(detached,other?'ATTEMPT IDS':'');
    const key={flight:'IN · In flight',held:'WAIT · Waiting',filed:'END · Terminal',failed:'ERR · Terminal failure',last:'OLD · Last observed',gap:'? · Unknown'};
    set(legend,'y',other?437:456);
    text(legend,Object.keys(key).filter(k=>badges.has(k)).map(k=>key[k]).join('    /    ')+overflow);
    hydrated=!!view;lastChanges=options.changedIds??null;
  }
  return {update,destroy(){
    if(disposed)return;disposed=true;
    for(const off of bindings)off();for(const r of marks.values()){r.unbind();r.pulse?.cancel();}
    for(const s of stations)s.pulse?.cancel();marks.clear();svg.remove();
  }};
}
