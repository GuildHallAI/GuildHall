"use client";
import {useEffect,useRef} from 'react';
import {usePathname} from 'next/navigation';
import {inkVertex,inkUpdate,inkDisplay} from './ink-shaders';

// This is the supplied ink field (two feedback buffers), rendered as a small,
// transparent overlay. No React updates occur during pointer movement.
export function InkCursor(){
 const pathname=usePathname();
 const dashboard=pathname==='/dashboard'||pathname?.startsWith('/dashboard/');
 const ref=useRef<HTMLCanvasElement>(null);
 useEffect(()=>{
  if(dashboard)return;
  const canvas=ref.current;
  const media=matchMedia('(hover:hover) and (pointer:fine) and (prefers-reduced-motion:no-preference)');
  if(!canvas||!media.matches)return;
  const gl=canvas.getContext('webgl',{alpha:true,antialias:false,depth:false,premultipliedAlpha:false,powerPreference:'low-power'});
  if(!gl)return;
  const shaders:WebGLShader[]=[],programs:WebGLProgram[]=[],buffers:WebGLBuffer[]=[],textures:WebGLTexture[]=[],frames:WebGLFramebuffer[]=[];
  let frame=0,disposed=false,width=2,height=2,read=0,lastT=0,lastMove=-10000,moved=false,click=0;
  let x=.5,y=.5,px=.5,py=.5;
  const drops=new Float32Array(72);
  const dispose=()=>{disposed=true;cancelAnimationFrame(frame);textures.forEach(t=>gl.deleteTexture(t));frames.forEach(f=>gl.deleteFramebuffer(f));buffers.forEach(b=>gl.deleteBuffer(b));programs.forEach(p=>gl.deleteProgram(p));shaders.forEach(s=>gl.deleteShader(s));canvas.style.opacity='0'};
  const program=(fragment:string)=>{
   const p=gl.createProgram()!;programs.push(p);
   for(const [type,code] of [[gl.VERTEX_SHADER,inkVertex],[gl.FRAGMENT_SHADER,fragment]] as const){const s=gl.createShader(type)!;shaders.push(s);gl.shaderSource(s,code);gl.compileShader(s);if(!gl.getShaderParameter(s,gl.COMPILE_STATUS))throw Error('Ink shader unavailable');gl.attachShader(p,s)}
   gl.linkProgram(p);if(!gl.getProgramParameter(p,gl.LINK_STATUS))throw Error('Ink program unavailable');
   const uniforms:Record<string,WebGLUniformLocation|null>={};for(const name of ['uPrev','uTrail','uResolution','uP0','uP1','uActive','uSpeed','uRadius','uDeposit','uSmear','uDecay','uDiffuse','uDrops[0]','uDropCount','uClick','uTime'])uniforms[name]=gl.getUniformLocation(p,name);
   return {p,u:uniforms,position:gl.getAttribLocation(p,'aPosition')};
  };
  try{
   const update=program(inkUpdate),display=program(inkDisplay);
   const geometry=gl.createBuffer()!;buffers.push(geometry);gl.bindBuffer(gl.ARRAY_BUFFER,geometry);gl.bufferData(gl.ARRAY_BUFFER,new Float32Array([-1,-1,1,-1,-1,1,-1,1,1,-1,1,1]),gl.STATIC_DRAW);
   let type:number=gl.UNSIGNED_BYTE;
   const half=gl.getExtension('OES_texture_half_float');if(half&&gl.getExtension('OES_texture_half_float_linear')&&gl.getExtension('EXT_color_buffer_half_float'))type=half.HALF_FLOAT_OES;
   for(let i=0;i<2;i++){const t=gl.createTexture()!,f=gl.createFramebuffer()!;textures.push(t);frames.push(f);gl.bindTexture(gl.TEXTURE_2D,t);gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MIN_FILTER,gl.LINEAR);gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MAG_FILTER,gl.LINEAR);gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_WRAP_S,gl.CLAMP_TO_EDGE);gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_WRAP_T,gl.CLAMP_TO_EDGE);gl.bindFramebuffer(gl.FRAMEBUFFER,f);gl.framebufferTexture2D(gl.FRAMEBUFFER,gl.COLOR_ATTACHMENT0,gl.TEXTURE_2D,t,0)}
   const clear=()=>{for(const f of frames){gl.bindFramebuffer(gl.FRAMEBUFFER,f);gl.clearColor(0,0,0,0);gl.clear(gl.COLOR_BUFFER_BIT)}gl.bindFramebuffer(gl.FRAMEBUFFER,null);gl.clear(gl.COLOR_BUFFER_BIT)};
   const resize=()=>{const scale=Math.min(.8,1100/Math.max(innerWidth,innerHeight));width=Math.max(2,Math.round(innerWidth*scale));height=Math.max(2,Math.round(innerHeight*scale));canvas.width=width;canvas.height=height;gl.viewport(0,0,width,height);for(let i=0;i<2;i++){gl.bindTexture(gl.TEXTURE_2D,textures[i]);gl.texImage2D(gl.TEXTURE_2D,0,gl.RGBA,width,height,0,gl.RGBA,type,null);gl.bindFramebuffer(gl.FRAMEBUFFER,frames[i]);if(gl.checkFramebufferStatus(gl.FRAMEBUFFER)!==gl.FRAMEBUFFER_COMPLETE)throw Error('Ink buffer unavailable')}clear()};
   const use=(p:ReturnType<typeof program>)=>{gl.useProgram(p.p);gl.bindBuffer(gl.ARRAY_BUFFER,geometry);gl.enableVertexAttribArray(p.position);gl.vertexAttribPointer(p.position,2,gl.FLOAT,false,0,0);gl.uniform2f(p.u.uResolution,width,height)};
   const render=(now:number)=>{
    frame=0;if(disposed||document.hidden||!media.matches)return;
    const dt=Math.min(.05,Math.max(.001,(now-lastT)/1000));lastT=now;const dtn=dt*60,speed=Math.hypot(x-px,y-py),radius=Math.min(.019,16/innerHeight);
    click*=Math.pow(.82,dtn);
    use(update);const u=update.u;
    gl.uniform2f(u.uP0,px,py);gl.uniform2f(u.uP1,x,y);gl.uniform1f(u.uActive,moved?1:0);gl.uniform1f(u.uSpeed,speed);gl.uniform1f(u.uRadius,radius);gl.uniform1f(u.uDeposit,1.10*dtn);gl.uniform1f(u.uSmear,5.5);gl.uniform1f(u.uDecay,Math.pow(.955,dtn));gl.uniform1f(u.uDiffuse,Math.min(.5,.16*dtn));gl.uniform1f(u.uClick,moved?click*1.6:0);gl.uniform1f(u.uTime,now/1000);
    let count=0;
    if(moved&&speed>.006){const aspect=width/height;let dx=(x-px)*aspect,dy=y-py;const len=Math.hypot(dx,dy)||1;dx/=len;dy/=len;count=Math.min(24,Math.floor(speed*55*.35*(.6+Math.random())));for(let i=0;i<count;i++){const fwd=(.1+.9*Math.random())*(speed*2.5+radius*1.5),side=(Math.random()*2-1)*(speed*3+radius*2);drops[i*3]=(x*aspect+dx*fwd-dy*side)/aspect;drops[i*3+1]=y+dy*fwd+dx*side;drops[i*3+2]=radius*(.05+.3*Math.pow(Math.random(),3))}}
    gl.uniform3fv(u['uDrops[0]'],drops);gl.uniform1i(u.uDropCount,count);gl.activeTexture(gl.TEXTURE0);gl.bindTexture(gl.TEXTURE_2D,textures[read]);gl.uniform1i(u.uPrev,0);gl.bindFramebuffer(gl.FRAMEBUFFER,frames[1-read]);gl.drawArrays(gl.TRIANGLES,0,6);read=1-read;
    use(display);gl.bindFramebuffer(gl.FRAMEBUFFER,null);gl.bindTexture(gl.TEXTURE_2D,textures[read]);gl.uniform1i(display.u.uTrail,0);gl.uniform1f(display.u.uTime,now/1000);gl.drawArrays(gl.TRIANGLES,0,6);
    px=x;py=y;moved=false;
    if(now-lastMove<1800)frame=requestAnimationFrame(render);else{clear();canvas.style.opacity='0'}
   };
   const move=(e:PointerEvent)=>{
    if(!media.matches||e.pointerType==='touch'||document.querySelector('.guild-preloader'))return;
    const now=performance.now(),nx=e.clientX/innerWidth,ny=1-e.clientY/innerHeight;
    if(now-lastMove>120){px=nx;py=ny}x=nx;y=ny;lastMove=now;moved=true;canvas.style.opacity='1';
    if(!frame){lastT=now-16.67;frame=requestAnimationFrame(render)}
   };
   const down=(e:PointerEvent)=>{move(e);click=1};
   const hide=()=>{cancelAnimationFrame(frame);frame=0;moved=false;lastMove=-10000;clear();canvas.style.opacity='0'};
   const lose=(e:Event)=>{e.preventDefault();hide();disposed=true};
   resize();window.addEventListener('pointermove',move,{passive:true});window.addEventListener('pointerdown',down,{passive:true});window.addEventListener('resize',resize);window.addEventListener('blur',hide);document.addEventListener('visibilitychange',hide);media.addEventListener('change',hide);canvas.addEventListener('webglcontextlost',lose);
   return()=>{window.removeEventListener('pointermove',move);window.removeEventListener('pointerdown',down);window.removeEventListener('resize',resize);window.removeEventListener('blur',hide);document.removeEventListener('visibilitychange',hide);media.removeEventListener('change',hide);canvas.removeEventListener('webglcontextlost',lose);dispose()};
  }catch{dispose()}
 },[dashboard]);
 if(dashboard)return null;
 return <canvas ref={ref} className="guild-ink-trail" aria-hidden="true"/>;
}
