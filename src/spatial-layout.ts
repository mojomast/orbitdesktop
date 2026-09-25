import { dimensions, type Monitor } from './model.ts';
export interface SpatialWindow { x:number; y:number; z:number; width:number; height:number; yaw:number; pitch:number; resolution:number }
export interface SpatialCamera { x:number; y:number; z:number; azimuth:number; elevation:number; distance:number }
export const defaultCamera = ():SpatialCamera => ({x:0,y:0.9,z:0,azimuth:0,elevation:0,distance:10});
export function spatialWindow(m:Monitor, monitors:Monitor[], arc:number):SpatialWindow {
  if(m.spatial) return {...m.spatial};
  const widths=monitors.map(v=>dimensions({...v,diagonal:32}).w);
  const total=widths.reduce((a,b)=>a+b,0)+Math.max(0,monitors.length-1)*0.24;
  const i=monitors.findIndex(v=>v.id===m.id);
  const cx=-total/2+widths.slice(0,i).reduce((a,b)=>a+b+0.24,0)+widths[i]/2;
  const {w,h}=dimensions(m);
  return {x:cx+m.offset,y:0.9+m.height,z:-m.distance-Math.abs(cx)*0.1,width:Math.min(200,w),height:Math.min(200,h),yaw:(i-(monitors.length-1)/2)*-arc+m.yaw,pitch:m.pitch,resolution:1920};
}
export function tileSpatial(monitors:Monitor[], mode:'grid'|'row'|'curve', columns=Math.ceil(Math.sqrt(monitors.length)), gap=0.35) {
  if(!['grid','row','curve'].includes(mode)||!Number.isInteger(columns)||columns<1||columns>monitors.length||!Number.isFinite(gap)||gap<0||gap>20)throw Error('Invalid spatial tiling');
  const cols=mode==='row'?monitors.length:columns, rows=Math.ceil(monitors.length/cols);
  const width=4.8,height=3, radius=Math.max(8,cols*width/Math.PI);
  monitors.forEach((m,i)=>{
    const col=i%cols,row=Math.floor(i/cols),x=(col-(cols-1)/2)*(width+gap),y=0.9+((rows-1)/2-row)*(height+gap);
    const angle=x/radius;
    m.spatial={x:mode==='curve'?Math.sin(angle)*radius:x,y,z:mode==='curve'?radius*(1-Math.cos(angle)):0,width,height,yaw:mode==='curve'?-angle*180/Math.PI:0,pitch:0,resolution:m.spatial?.resolution??1920};
  });
}
export function validSpatial(s:SpatialWindow):boolean {
  return !!s && typeof s==='object' && Object.keys(s).length===8 &&
    ['x','y','z'].every(k=>Number.isFinite(s[k as keyof SpatialWindow])&&Math.abs(s[k as keyof SpatialWindow])<=10000)&&
    ['width','height'].every(k=>Number.isFinite(s[k as keyof SpatialWindow])&&s[k as keyof SpatialWindow]>=0.3&&s[k as keyof SpatialWindow]<=200)&&
    Number.isFinite(s.yaw)&&Math.abs(s.yaw)<=360&&Number.isFinite(s.pitch)&&Math.abs(s.pitch)<=89&&[1280,1920,2560,3840].includes(s.resolution);
}
export function validCamera(c:SpatialCamera):boolean {
  return !!c&&typeof c==='object'&&['x','y','z'].every(k=>Number.isFinite(c[k as keyof SpatialCamera])&&Math.abs(c[k as keyof SpatialCamera])<=10000)&&Number.isFinite(c.azimuth)&&Math.abs(c.azimuth)<=Math.PI*2&&Number.isFinite(c.elevation)&&Math.abs(c.elevation)<=1.5&&Number.isFinite(c.distance)&&c.distance>=0.2&&c.distance<=2000;
}
