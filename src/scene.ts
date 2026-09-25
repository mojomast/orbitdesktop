import * as THREE from 'three';
import { CSS3DRenderer, CSS3DObject } from 'three/addons/renderers/CSS3DRenderer.js';
import type { Monitor } from './model';
import { defaultCamera, spatialWindow, type SpatialCamera, type SpatialWindow } from './spatial-layout';
import './spatial.css';
const clamp = THREE.MathUtils.clamp;
export class DesktopScene {
  private world = new THREE.Scene();
  private cssScene = new THREE.Scene();
  private camera = new THREE.PerspectiveCamera(45,1,0.01,30000);
  private gl:THREE.WebGLRenderer|null=null;
  private css = new CSS3DRenderer();
  private objects = new Map<string,{css:CSS3DObject; edges:THREE.LineSegments}>();
  private monitors:Monitor[]=[];
  private arc=0;
  private pose=defaultCamera();
  private initialized=false;
  private dirty=true;
  private frame=0;
  private disposed=false;
  private observer:ResizeObserver;
  private events=new AbortController();
  private navigating=false;
  private keys=new Set<string>();
  private onCamera:(pose:SpatialCamera)=>void=()=>{};
  constructor(private host:HTMLElement) {
    host.tabIndex=0;
    host.setAttribute('aria-label','3D workspace. Drag background to orbit, Shift drag to pan, scroll to zoom.');
    try {
      this.gl=new THREE.WebGLRenderer({antialias:true,alpha:true});
      this.gl.setPixelRatio(Math.min(devicePixelRatio,2));
      this.gl.domElement.className='world-canvas'; host.append(this.gl.domElement);
    } catch { host.classList.add('no-webgl'); }
    const grid=new THREE.GridHelper(400,200,'#50656d','#27333b'); grid.position.y=-3; this.world.add(grid);
    this.css.domElement.className='css-world'; host.append(this.css.domElement);
    const signal=this.events.signal;
    let drag:{x:number;y:number;pan:boolean}|null=null;
    host.addEventListener('pointerdown',e=>{
      if((e.target as HTMLElement).closest('.spatial-toolbar'))return;
      if(!this.navigating&&(e.target as HTMLElement).closest('.monitor')&&!e.altKey)return;
      if(e.button!==0&&e.button!==1&&e.button!==2)return;
      drag={x:e.clientX,y:e.clientY,pan:e.shiftKey||e.button!==0};
      host.focus({preventScroll:true}); host.setPointerCapture(e.pointerId);e.preventDefault();
    },{signal});
    host.addEventListener('pointermove',e=>{
      if(!drag)return;
      const dx=e.clientX-drag.x,dy=e.clientY-drag.y;drag.x=e.clientX;drag.y=e.clientY;
      if(drag.pan)this.pan(-dx,dy);
      else {
        this.pose.azimuth=((this.pose.azimuth-dx*0.005)%(Math.PI*2));
        this.pose.elevation=clamp(this.pose.elevation+dy*0.005,-1.5,1.5);
        this.updateCamera(true);
      }
    },{signal});
    const end=()=>{drag=null;};
    for(const name of ['pointerup','pointercancel','lostpointercapture'])host.addEventListener(name,end,{signal});
    host.addEventListener('contextmenu',e=>{if(this.navigating||!(e.target as HTMLElement).closest('.monitor'))e.preventDefault();},{signal});
    host.addEventListener('wheel',e=>{
      if((e.target as HTMLElement).closest('.spatial-toolbar'))return;
      if(this.navigating||!(e.target as HTMLElement).closest('.monitor')||e.altKey){e.preventDefault();this.zoom(clamp(e.deltaY,-200,200)*0.002);}
    },{passive:false,signal});
    host.addEventListener('keydown',e=>{
      if(e.key==='Escape'){this.setNavigation(false);return;}
      if(!this.navigating||e.target!==host||e.ctrlKey||e.metaKey||e.altKey)return;
      if(['w','a','s','d','q','e','ArrowUp','ArrowDown','ArrowLeft','ArrowRight'].includes(e.key)){this.keys.add(e.key.toLowerCase());e.preventDefault();}
    },{signal});
    host.addEventListener('keyup',e=>this.keys.delete(e.key.toLowerCase()),{signal});
    host.addEventListener('blur',()=>this.keys.clear(),{signal});
    let previous=performance.now();
    const tick=(now:number)=>{
      if(this.disposed)return; this.frame=requestAnimationFrame(tick);
      const dt=Math.min(0.05,(now-previous)/1000); previous=now;
      if(this.navigating&&this.keys.size&&!document.hidden){
        const k=this.keys,speed=Math.max(1,this.pose.distance*0.5)*dt;
        const right=new THREE.Vector3().setFromMatrixColumn(this.camera.matrixWorld,0);
        const forward=this.camera.getWorldDirection(new THREE.Vector3());
        const delta=new THREE.Vector3().addScaledVector(right,((k.has('d')||k.has('arrowright')?1:0)-(k.has('a')||k.has('arrowleft')?1:0))*speed)
          .addScaledVector(forward,((k.has('w')||k.has('arrowup')?1:0)-(k.has('s')||k.has('arrowdown')?1:0))*speed);
        delta.y+=((k.has('e')?1:0)-(k.has('q')?1:0))*speed;this.translate(delta);
      }
      if(this.dirty&&!document.hidden){this.gl?.render(this.world,this.camera);this.css.render(this.cssScene,this.camera);this.dirty=false;}
    };
    this.frame=requestAnimationFrame(tick);
    this.observer=new ResizeObserver(()=>this.resize());this.observer.observe(host);this.resize();
  }
  configureCamera(pose:SpatialCamera|undefined,onChange:(pose:SpatialCamera)=>void){
    this.onCamera=onChange;
    if(pose){this.pose={...pose};this.initialized=true;this.updateCamera();}
  }
  setNavigation(value:boolean){
    this.navigating=value;this.keys.clear();this.host.classList.toggle('spatial-navigating',value);
    this.host.dispatchEvent(new CustomEvent('spatial-navigation',{detail:value}));
    if(value)this.host.focus({preventScroll:true});
  }
  private translate(delta:THREE.Vector3){
    this.pose.x=clamp(this.pose.x+delta.x,-10000,10000);this.pose.y=clamp(this.pose.y+delta.y,-10000,10000);this.pose.z=clamp(this.pose.z+delta.z,-10000,10000);this.updateCamera(true);
  }
  private pan(dx:number,dy:number){
    const scale=2*this.pose.distance*Math.tan(Math.PI/8)/Math.max(1,this.host.clientHeight);
    this.translate(new THREE.Vector3().setFromMatrixColumn(this.camera.matrixWorld,0).multiplyScalar(dx*scale)
      .addScaledVector(new THREE.Vector3().setFromMatrixColumn(this.camera.matrixWorld,1),dy*scale));
  }
  private updateCamera(save=false){
    const p=this.pose;
    this.camera.position.set(p.x+Math.sin(p.azimuth)*Math.cos(p.elevation)*p.distance,p.y+Math.sin(p.elevation)*p.distance,p.z+Math.cos(p.azimuth)*Math.cos(p.elevation)*p.distance);
    this.camera.lookAt(p.x,p.y,p.z);this.camera.updateMatrixWorld();this.dirty=true;
    if(save)this.onCamera({...p});
  }
  zoom(delta:number){this.pose.distance=clamp(this.pose.distance*Math.exp(delta),0.2,2000);this.updateCamera(true);}
  reset(){this.frameAll();}
  frameAll(){
    const box=new THREE.Box3();
    for(const m of this.monitors){const s=spatialWindow(m,this.monitors,this.arc),r=Math.hypot(s.width,s.height)/2;box.expandByPoint(new THREE.Vector3(s.x-r,s.y-r,s.z-r));box.expandByPoint(new THREE.Vector3(s.x+r,s.y+r,s.z+r));}
    if(box.isEmpty())return;
    const c=box.getCenter(new THREE.Vector3()),size=box.getSize(new THREE.Vector3());
    this.pose={x:c.x,y:c.y,z:c.z,azimuth:0,elevation:0,distance:clamp(Math.max(size.y,size.x/this.camera.aspect)/(2*Math.tan(Math.PI/8))+size.z/2,0.2,2000)};
    this.initialized=true;this.updateCamera(true);
  }
  frameWindow(id:string){
    const m=this.monitors.find(m=>m.id===id);if(!m)return;
    const s=spatialWindow(m,this.monitors,this.arc);
    this.pose={x:s.x,y:s.y,z:s.z,azimuth:THREE.MathUtils.degToRad(s.yaw),elevation:clamp(-THREE.MathUtils.degToRad(s.pitch),-1.5,1.5),distance:clamp(Math.max(s.height,s.width/this.camera.aspect)/(2*Math.tan(Math.PI/8))*1.15,0.2,2000)};
    this.updateCamera(true);
  }
  private ray(x:number,y:number){
    const r=this.host.getBoundingClientRect(),ray=new THREE.Raycaster();
    ray.setFromCamera(new THREE.Vector2((x-r.left)/r.width*2-1,-(y-r.top)/r.height*2+1),this.camera);return ray.ray;
  }
  wireSpatial(bar:HTMLElement,handle:HTMLElement,m:Monitor,enabled:()=>boolean,changed:()=>void,finished:()=>void){
    bar.title='Drag to move · Shift drag for depth · Ctrl/⌘ drag to rotate · Double-click to approach';
    bar.addEventListener('dblclick',e=>{if(enabled()&&!(e.target as HTMLElement).closest('button,input,select'))this.frameWindow(m.id);});
    for(const [target,resizing] of [[bar,false],[handle,true]] as const){
      let start:{s:SpatialWindow;point:THREE.Vector3;plane:THREE.Plane;rotation:THREE.Quaternion;x:number;y:number;mode:string}|null=null;
      target.addEventListener('pointerdown',e=>{
        if(!enabled()||this.navigating||e.altKey||e.button!==0||(!resizing&&(e.target as HTMLElement).closest('button,input,select')))return;
        const o=this.objects.get(m.id);if(!o)return;
        const s=spatialWindow(m,this.monitors,this.arc),rotation=o.css.quaternion.clone();
        const normal=resizing?new THREE.Vector3(0,0,1).applyQuaternion(rotation):this.camera.getWorldDirection(new THREE.Vector3());
        const plane=new THREE.Plane().setFromNormalAndCoplanarPoint(normal,o.css.position);
        const point=this.ray(e.clientX,e.clientY).intersectPlane(plane,new THREE.Vector3());if(!point)return;
        start={s,point,plane,rotation,x:e.clientX,y:e.clientY,mode:e.shiftKey?'depth':e.ctrlKey||e.metaKey?'rotate':'move'};
        target.setPointerCapture(e.pointerId);e.preventDefault();e.stopPropagation();document.body.classList.add('window-dragging');
      });
      target.addEventListener('pointermove',e=>{
        if(!start)return;
        const s={...start.s},dx=e.clientX-start.x,dy=e.clientY-start.y;
        const hit=this.ray(e.clientX,e.clientY).intersectPlane(start.plane,new THREE.Vector3());if(!hit)return;
        const delta=hit.sub(start.point);
        if(resizing){
          delta.applyQuaternion(start.rotation.clone().invert());
          const w=clamp(s.width+delta.x,0.3,200),h=clamp(s.height-delta.y,0.3,200);
          const center=new THREE.Vector3((w-s.width)/2,-(h-s.height)/2,0).applyQuaternion(start.rotation);
          s.width=w;s.height=h;s.x+=center.x;s.y+=center.y;s.z+=center.z;
        }else if(start.mode==='depth')s.z-=dy*this.pose.distance/Math.max(1,this.host.clientHeight)*2;
        else if(start.mode==='rotate'){s.yaw=clamp(s.yaw+dx*0.3,-360,360);s.pitch=clamp(s.pitch+dy*0.3,-89,89);}
        else{s.x+=delta.x;s.y+=delta.y;s.z+=delta.z;}
        s.x=clamp(s.x,-10000,10000);s.y=clamp(s.y,-10000,10000);s.z=clamp(s.z,-10000,10000);
        m.spatial=s;changed();
      });
      const finish=()=>{if(!start)return;start=null;document.body.classList.remove('window-dragging');finished();};
      target.addEventListener('pointerup',finish);target.addEventListener('pointercancel',finish);target.addEventListener('lostpointercapture',finish);
    }
  }
  resize(){
    const w=this.host.clientWidth,h=this.host.clientHeight;if(!w||!h)return;
    this.camera.aspect=w/h;this.camera.updateProjectionMatrix();this.gl?.setSize(w,h);this.css.setSize(w,h);this.updateCamera();
  }
  update(monitors:Monitor[],elements:Map<string,HTMLElement>,selected:string,arc:number){
    this.monitors=monitors;this.arc=arc;
    for(const [id,o] of this.objects)if(!monitors.some(m=>m.id===id)){
      this.cssScene.remove(o.css);this.world.remove(o.edges);o.edges.geometry.dispose();(o.edges.material as THREE.Material).dispose();this.objects.delete(id);
    }
    for(const m of monitors){
      const s=spatialWindow(m,monitors,arc);let o=this.objects.get(m.id);
      if(!o){
        const wrapper=document.createElement('div');wrapper.className='monitor-anchor';wrapper.dataset.anchorId=m.id;wrapper.append(elements.get(m.id)!);
        const css=new CSS3DObject(wrapper),edges=new THREE.LineSegments(new THREE.EdgesGeometry(new THREE.PlaneGeometry(1,1)),new THREE.LineBasicMaterial({color:'#536357'}));
        o={css,edges};this.objects.set(m.id,o);this.cssScene.add(css);this.world.add(edges);
      }
      o.css.position.set(s.x,s.y,s.z);o.css.rotation.set(THREE.MathUtils.degToRad(s.pitch),THREE.MathUtils.degToRad(s.yaw),0);
      // Native DOM, never a screenshot texture. Resolution is explicit and stable while navigating.
      const pixels=Math.min(s.resolution,4096*s.width/s.height);
      o.css.scale.setScalar(s.width/pixels);o.css.element.style.width=`${pixels}px`;o.css.element.style.height=`${pixels*s.height/s.width}px`;
      const element=elements.get(m.id)!;element.classList.toggle('selected',m.id===selected);
      o.edges.visible=!element.classList.contains('window-minimized');o.edges.position.copy(o.css.position);o.edges.quaternion.copy(o.css.quaternion);o.edges.scale.set(s.width,s.height,1);
      (o.edges.material as THREE.LineBasicMaterial).color.set(m.id===selected?'#c2ed90':'#536357');
    }
    if(!this.initialized)this.frameAll();else this.dirty=true;
  }
  dispose(){this.disposed=true;cancelAnimationFrame(this.frame);this.events.abort();this.observer.disconnect();this.world.traverse(o=>{if(o instanceof THREE.Mesh||o instanceof THREE.LineSegments){o.geometry.dispose();(Array.isArray(o.material)?o.material:[o.material]).forEach(m=>m.dispose());}});this.gl?.dispose();}
}
