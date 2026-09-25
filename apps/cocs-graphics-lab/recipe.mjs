export const ranges={exposure:[.3,2.5,1],bloom:[0,2,0],saturation:[0,2,1],contrast:[.5,1.8,1],tintMix:[0,.65,0],vignette:[0,1,0],chromatic:[0,.012,0],grain:[0,.15,0],scanlines:[0,.35,0],pixelSize:[1,12,1],warp:[0,.15,0],fov:[40,105,65]};
export const defaults=Object.fromEntries(Object.entries(ranges).map(([k,v])=>[k,v[2]]));defaults.tint='#66ffcc';
export const presets={Neutral:{},'Overdrive amber':{bloom:.55,exposure:1.15,saturation:1.2,tint:'#ffb65c',tintMix:.16,vignette:.3,chromatic:.002,fov:78},'Shield frost':{bloom:.4,tint:'#65beff',tintMix:.3,vignette:.35,contrast:1.12},'Void phase':{saturation:.45,tint:'#b885ff',tintMix:.25,chromatic:.005,warp:.05,vignette:.5},'Recon scanner':{saturation:.15,tint:'#6effaa',tintMix:.4,scanlines:.12,contrast:1.25,vignette:.25},'Retro pickup':{pixelSize:5,saturation:1.4,grain:.05,scanlines:.1}};
export function validateRecipe(value){if(!value||typeof value!=='object'||Array.isArray(value))throw Error('Recipe must be an object');const r={...defaults};for(const [k,[lo,hi]] of Object.entries(ranges)){if(value[k]!==undefined){if(typeof value[k]!=='number'||!Number.isFinite(value[k])||value[k]<lo||value[k]>hi)throw Error('Invalid '+k);r[k]=value[k];}}if(value.tint!==undefined){if(typeof value.tint!=='string'||!/^#[0-9a-f]{6}$/i.test(value.tint))throw Error('Invalid tint');r.tint=value.tint;}return r;}
export function variation(base,seed){let s=seed>>>0;const rand=()=>{s=(Math.imul(1664525,s)+1013904223)>>>0;return s/4294967296;};const r={...base};for(const [key,amount] of Object.entries({bloom:.5,saturation:.4,contrast:.25,tintMix:.18,vignette:.25,chromatic:.003,warp:.04})){const [lo,hi]=ranges[key];r[key]=Math.round(Math.max(lo,Math.min(hi,r[key]+(rand()-.5)*amount))*10000)/10000;}return validateRecipe(r);}
export const vertexShader='varying vec2 vUv; void main(){vUv=uv;gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.0);}';
export const fragmentShader=`uniform sampler2D tDiffuse;
uniform vec2 resolution;
uniform float saturation,contrast,tintMix,vignette,chromatic,grain,scanlines,pixelSize,warp,time;
uniform vec3 tint;
varying vec2 vUv;
void main(){
 vec2 p=vUv-.5; vec2 uv=.5+p*(1.+warp*dot(p,p)*4.);
 if(pixelSize>1.)uv=(floor(uv*resolution/pixelSize)+.5)*pixelSize/resolution;
 uv=clamp(uv,vec2(.001),vec2(.999));
 vec2 shift=p*chromatic;
 vec3 col=vec3(texture2D(tDiffuse,clamp(uv+shift,0.,1.)).r,texture2D(tDiffuse,uv).g,texture2D(tDiffuse,clamp(uv-shift,0.,1.)).b);
 float l=dot(col,vec3(.2126,.7152,.0722));
 col=mix(vec3(l),col,saturation);
 col=(col-.5)*contrast+.5;
 col=mix(col,col*tint*1.6,tintMix);
 col*=1.-vignette*smoothstep(.15,.75,length(p));
 col*=1.-scanlines*(.5+.5*sin(vUv.y*resolution.y*3.14159265));
 float noise=fract(sin(dot(floor(vUv*resolution)+floor(time*12.),vec2(12.9898,78.233)))*43758.5453)-.5;
 col+=noise*grain;
 gl_FragColor=vec4(clamp(col,0.,1.),1.);
}`;
export function brief(recipe,context){return `Implement this COCS Graphics Lab recipe for the local player's view.\nSituation: ${context.situation}\nPowerup/event: ${context.trigger}\nDuration seconds: ${context.duration}; fade-in seconds: ${context.fadeIn}; fade-out seconds: ${context.fadeOut}.\nOwner prompt: ${context.prompt}\nRecipe schema version 1: ${JSON.stringify(validateRecipe(recipe))}\nReference scene: ${context.scene}; camera FOV is recipe.fov. Values represent a visual target, not existing game configuration keys. Bloom uses UnrealBloomPass strength (radius .4, threshold .8). Exposure uses ACESFilmicToneMapping. Order: scene -> bloom -> OutputPass -> grade shader (display-referred). Match the shader below, with resolution in drawing-buffer pixels and tint RGB from the hex value WITHOUT sRGB-to-linear conversion. Effects default to neutral outside the trigger.\nIntegrate with actual powerup lifecycle in current game source. Affect only the appropriate local player, never simulation stats or other players' cameras. Handle expiry, death, respawn, stacking and reduced-motion/low-quality settings; no flashing. Preserve HUD readability, existing postprocessing and restore the user's baseline FOV. Add no dependency. Explain exact trigger and lifecycle wiring and how to verify in-game. Do not claim a static preview proves event behavior. Do not commit or publish.\nVertex shader:\n${vertexShader}\nFragment shader:\n${fragmentShader}`;}
