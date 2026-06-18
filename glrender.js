"use strict";
/* WildmanDesigns — WebGL image renderer
   GPU fragment shader handles: exposure, temperature, tint, contrast (via LUT),
   highlights, shadows, whites, blacks, vibrance, saturation, HSL per-hue
   adjustments, split tone, and per-channel RGB curves — all in one pass.
   Falls back silently to CPU (engine.js) when WebGL is unavailable.         */

const GL = (() => {
  /* ── Vertex shader ─────────────────────────────────────────────────── */
  const VERT = `
attribute vec2 a_pos;
attribute vec2 a_tc;
varying vec2 v_tc;
void main(){ gl_Position=vec4(a_pos,0.0,1.0); v_tc=a_tc; }`;

  /* ── Fragment shader ────────────────────────────────────────────────── */
  const FRAG = `
precision highp float;
uniform sampler2D u_img;   /* source image             */
uniform sampler2D u_lut;   /* 256×1 tonal LUT (R chan) */
uniform sampler2D u_lutR;  /* 256×1 RGB-curve R        */
uniform sampler2D u_lutG;  /* 256×1 RGB-curve G        */
uniform sampler2D u_lutB;  /* 256×1 RGB-curve B        */

/* Basic adjustments */
uniform float u_expF;   /* pow(2, exposure)   */
uniform float u_tempF;  /* temp/100           */
uniform float u_tintF;  /* tint/100           */
uniform float u_sat;    /* saturation/100     */
uniform float u_vib;    /* vibrance/100       */

/* HSL: 8 hue ranges × (delta-hue°, delta-sat, delta-lum) */
uniform vec3 u_hsl0; uniform vec3 u_hsl1; uniform vec3 u_hsl2; uniform vec3 u_hsl3;
uniform vec3 u_hsl4; uniform vec3 u_hsl5; uniform vec3 u_hsl6; uniform vec3 u_hsl7;
/* hue centre + half-width for each range */
const float HC[8] = float[8](  0.0, 30.0, 60.0,120.0,180.0,240.0,280.0,330.0);
const float HW[8] = float[8]( 35.0, 25.0, 25.0, 35.0, 30.0, 35.0, 30.0, 35.0);

/* Split tone */
uniform float u_stSH, u_stSS, u_stHH, u_stHS, u_stBal;
uniform float u_grain;

varying vec2 v_tc;

/* ── helpers ── */
float lutSample(sampler2D t, float v){
  return texture2D(t, vec2(v*(255.0/256.0)+0.5/256.0, 0.5)).r;
}

vec3 hsl2rgb(float h, float s, float l){
  float c=(1.0-abs(2.0*l-1.0))*s;
  float x=c*(1.0-abs(mod(h/60.0,2.0)-1.0));
  float m=l-c/2.0;
  vec3 r;
  if(h<60.0)       r=vec3(c,x,0.0);
  else if(h<120.0) r=vec3(x,c,0.0);
  else if(h<180.0) r=vec3(0.0,c,x);
  else if(h<240.0) r=vec3(0.0,x,c);
  else if(h<300.0) r=vec3(x,0.0,c);
  else             r=vec3(c,0.0,x);
  return r+m;
}

void main(){
  vec4 px = texture2D(u_img, v_tc);
  vec3 c  = px.rgb;

  /* 1 ── Exposure + temperature + tint gain per channel */
  c.r = clamp(c.r*(1.0+0.30*u_tempF)*u_expF, 0.0, 1.0);
  c.g = clamp(c.g*(1.0-0.18*u_tintF)*u_expF, 0.0, 1.0);
  c.b = clamp(c.b*(1.0-0.30*u_tempF)*u_expF, 0.0, 1.0);

  /* 2 ── Tonal LUT (encodes contrast, highlights, shadows, whites, blacks, curve) */
  c = vec3(lutSample(u_lut,c.r), lutSample(u_lut,c.g), lutSample(u_lut,c.b));

  /* 3 ── Saturation + vibrance */
  float luma = dot(c, vec3(0.299,0.587,0.114));
  float mx   = max(max(c.r,c.g),c.b);
  float mn   = min(min(c.r,c.g),c.b);
  float curSat = mx>0.001 ? (mx-mn)/mx : 0.0;
  float f = 1.0 + u_sat + u_vib*(1.0-curSat);
  c = clamp(luma+(c-luma)*f, 0.0, 1.0);

  /* 4 ── HSL per-hue adjustments */
  {
    float d=mx-mn, h=0.0, s=0.0, l=(mx+mn)/2.0;
    if(d>0.001){
      s = d/(1.0-abs(2.0*l-1.0));
      if(mx==c.r)      h=mod((c.g-c.b)/d,6.0)*60.0;
      else if(mx==c.g) h=((c.b-c.r)/d+2.0)*60.0;
      else             h=((c.r-c.g)/d+4.0)*60.0;
      if(h<0.0) h+=360.0;
    }
    if(s>0.01){
      /* unroll 8 ranges — GLSL ES 1.0 needs explicit indexing */
      vec3 hslDeltas[8];
      hslDeltas[0]=u_hsl0; hslDeltas[1]=u_hsl1; hslDeltas[2]=u_hsl2; hslDeltas[3]=u_hsl3;
      hslDeltas[4]=u_hsl4; hslDeltas[5]=u_hsl5; hslDeltas[6]=u_hsl6; hslDeltas[7]=u_hsl7;
      float dh=0.0, ds=0.0, dl=0.0;
      for(int i=0;i<8;i++){
        float diff=abs(h-HC[i]);
        if(diff>180.0) diff=360.0-diff;
        float w=clamp(1.0-diff/HW[i],0.0,1.0);
        if(w>0.0){ dh+=hslDeltas[i].x*w; ds+=hslDeltas[i].y*w; dl+=hslDeltas[i].z*w; }
      }
      if(abs(dh)+abs(ds)+abs(dl)>0.0){
        h=mod(h+dh+360.0,360.0);
        s=clamp(s+ds,0.0,1.0);
        l=clamp(l+dl,0.0,1.0);
        c=hsl2rgb(h,s,l);
      }
    }
  }

  /* 5 ── Split tone */
  if(u_stSS>0.001||u_stHS>0.001){
    float l2=dot(c,vec3(0.299,0.587,0.114));
    float hw=clamp(l2*(1.0+u_stBal),0.0,1.0);
    float sw=clamp((1.0-l2)*(1.0-u_stBal),0.0,1.0);
    if(u_stSS>0.001){ vec3 sc=hsl2rgb(u_stSH,u_stSS,0.5); c+=(sc-0.5)*sw*0.4; }
    if(u_stHS>0.001){ vec3 hc=hsl2rgb(u_stHH,u_stHS,0.5); c+=(hc-0.5)*hw*0.4; }
    c=clamp(c,0.0,1.0);
  }

  /* Grain */
  if(u_grain>0.0){
    vec2 gp=floor(v_tc*vec2(4096.0));
    float h=fract(sin(dot(gp,vec2(127.1,311.7)))*43758.5453);
    float h2=fract(sin(dot(gp+1.0,vec2(269.5,183.3)))*43758.5453);
    c=clamp(c+(h+h2-1.0)*u_grain*0.12,0.0,1.0);
  }

  /* 6 ── Per-channel RGB curves */
  c=vec3(lutSample(u_lutR,c.r), lutSample(u_lutG,c.g), lutSample(u_lutB,c.b));

  gl_FragColor=vec4(c,px.a);
}`;

  /* ── WebGL state ─────────────────────────────────────────────────── */
  let gl=null, prog=null, posB=null, tcB=null;
  let texImage=null, texLUT=null, texLutR=null, texLutG=null, texLutB=null;
  let lastBitmap=null;
  const offscreen=document.createElement('canvas');
  let available=false;

  function compile(type, src){
    const s=gl.createShader(type); gl.shaderSource(s,src); gl.compileShader(s);
    if(!gl.getShaderParameter(s,gl.COMPILE_STATUS))
      throw new Error('GL shader: '+gl.getShaderInfoLog(s));
    return s;
  }

  function makeTex(data256){
    /* Build a 256×1 RGBA texture from a Float32Array[256] in [0,1] */
    const px=new Uint8Array(256*4);
    for(let i=0;i<256;i++){
      const v=Math.round(Math.min(1,Math.max(0,data256[i]))*255);
      px[i*4]=px[i*4+1]=px[i*4+2]=v; px[i*4+3]=255;
    }
    const t=gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D,t);
    gl.texImage2D(gl.TEXTURE_2D,0,gl.RGBA,256,1,0,gl.RGBA,gl.UNSIGNED_BYTE,px);
    gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MIN_FILTER,gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MAG_FILTER,gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_WRAP_S,gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_WRAP_T,gl.CLAMP_TO_EDGE);
    return t;
  }

  function identityLUT(){
    const a=new Float32Array(256);
    for(let i=0;i<256;i++) a[i]=i/255;
    return a;
  }

  function init(){
    try{
      gl=offscreen.getContext('webgl',{premultipliedAlpha:false,preserveDrawingBuffer:false})
        || offscreen.getContext('experimental-webgl',{premultipliedAlpha:false});
      if(!gl) throw new Error('no webgl');

      const vs=compile(gl.VERTEX_SHADER,VERT);
      const fs=compile(gl.FRAGMENT_SHADER,FRAG);
      prog=gl.createProgram();
      gl.attachShader(prog,vs); gl.attachShader(prog,fs); gl.linkProgram(prog);
      if(!gl.getProgramParameter(prog,gl.LINK_STATUS))
        throw new Error('GL link: '+gl.getProgramInfoLog(prog));

      /* quad covering full clip space */
      posB=gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER,posB);
      gl.bufferData(gl.ARRAY_BUFFER,new Float32Array([-1,-1, 1,-1, -1,1, 1,1]),gl.STATIC_DRAW);
      tcB=gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER,tcB);
      gl.bufferData(gl.ARRAY_BUFFER,new Float32Array([0,1, 1,1, 0,0, 1,0]),gl.STATIC_DRAW);

      /* identity LUTs (replaced on each render call) */
      const id=identityLUT();
      texLUT=makeTex(id); texLutR=makeTex(id); texLutG=makeTex(id); texLutB=makeTex(id);

      /* image texture placeholder */
      texImage=gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D,texImage);
      gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MIN_FILTER,gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MAG_FILTER,gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_WRAP_S,gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_WRAP_T,gl.CLAMP_TO_EDGE);

      available=true;
    }catch(e){
      console.warn('WebGL unavailable, using CPU renderer:',e.message);
      available=false;
    }
  }

  function updateLUT(tex, data){
    gl.bindTexture(gl.TEXTURE_2D,tex);
    const px=new Uint8Array(256*4);
    for(let i=0;i<256;i++){
      const v=Math.round(Math.min(1,Math.max(0,data[i]))*255);
      px[i*4]=px[i*4+1]=px[i*4+2]=v; px[i*4+3]=255;
    }
    gl.texImage2D(gl.TEXTURE_2D,0,gl.RGBA,256,1,0,gl.RGBA,gl.UNSIGNED_BYTE,px);
  }

  function u(name){ return gl.getUniformLocation(prog,name); }

  /* Returns true if all adjustments in adj are handled by the GPU shader.
     Clarity, sharpen, dehaze, denoise, lens distortion, perspective need CPU. */
  function canHandleAdj(adj){
    return !adj.clarity && !adj.sharpen && !adj.dehaze &&
           !adj.denoiseL && !adj.denoiseC &&
           !adj.distort && !adj.vignette2 &&
           !adj.vertPersp && !adj.horizPersp &&
           !adj.cubeLut;
  }

  /* Render bitmap → destCanvas at width w × height h using WebGL.
     adj must be the full adjustment object from DEFAULT_ADJ.
     Returns true on success, false if GL unavailable.                    */
  function renderTo(bitmap, adj, destCanvas, w, h){
    if(!available) return false;
    try{
      offscreen.width=w; offscreen.height=h;
      gl.viewport(0,0,w,h);
      gl.useProgram(prog);

      /* ── Upload source image (only if changed) ── */
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D,texImage);
      if(bitmap!==lastBitmap){
        gl.texImage2D(gl.TEXTURE_2D,0,gl.RGBA,gl.RGBA,gl.UNSIGNED_BYTE,bitmap);
        lastBitmap=bitmap;
      }
      gl.uniform1i(u('u_img'),0);

      /* ── Build and upload tonal LUT ── */
      const lut=buildLUT(adj);
      updateLUT(texLUT,lut);
      gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D,texLUT); gl.uniform1i(u('u_lut'),1);

      /* ── Per-channel RGB curve LUTs ── */
      const buildCh=pts=>{ const a=new Float32Array(256); const ps=[...pts].sort((a,b)=>a[0]-b[0]);
        for(let x=0;x<256;x++){ let i=0; while(i<ps.length-1&&ps[i+1][0]<x)i++;
          const a0=ps[i],b0=ps[Math.min(i+1,ps.length-1)];
          const t=b0[0]===a0[0]?0:(x-a0[0])/(b0[0]-a0[0]);
          a[x]=Math.min(1,Math.max(0,(a0[1]+(b0[1]-a0[1])*t)/255)); }
        return a; };
      const rc=adj.rgbCurves||{r:[[0,0],[255,255]],g:[[0,0],[255,255]],b:[[0,0],[255,255]]};
      updateLUT(texLutR,buildCh(rc.r));
      updateLUT(texLutG,buildCh(rc.g));
      updateLUT(texLutB,buildCh(rc.b));
      gl.activeTexture(gl.TEXTURE2); gl.bindTexture(gl.TEXTURE_2D,texLutR); gl.uniform1i(u('u_lutR'),2);
      gl.activeTexture(gl.TEXTURE3); gl.bindTexture(gl.TEXTURE_2D,texLutG); gl.uniform1i(u('u_lutG'),3);
      gl.activeTexture(gl.TEXTURE4); gl.bindTexture(gl.TEXTURE_2D,texLutB); gl.uniform1i(u('u_lutB'),4);

      /* ── Basic adjustment uniforms ── */
      gl.uniform1f(u('u_expF'), Math.pow(2, adj.exposure||0));
      gl.uniform1f(u('u_grain'), (adj.grain||0)/100);
      gl.uniform1f(u('u_tempF'),(adj.temp||0)/100);
      gl.uniform1f(u('u_tintF'),(adj.tint||0)/100);
      gl.uniform1f(u('u_sat'),  (adj.saturation||0)/100);
      gl.uniform1f(u('u_vib'),  (adj.vibrance||0)/100);

      /* ── HSL uniforms ── */
      const RANGES=['red','orange','yellow','green','aqua','blue','purple','magenta'];
      const hsl=adj.hsl||{};
      RANGES.forEach((r,i)=>{
        const h=hsl[r]||{h:0,s:0,l:0};
        gl.uniform3f(u('u_hsl'+i), h.h||0, (h.s||0)/100, (h.l||0)/100);
      });

      /* ── Split tone uniforms ── */
      const st=adj.splitTone||{shadowHue:0,shadowSat:0,highlightHue:0,highlightSat:0,balance:0};
      gl.uniform1f(u('u_stSH'), st.shadowHue||0);
      gl.uniform1f(u('u_stSS'),(st.shadowSat||0)/100);
      gl.uniform1f(u('u_stHH'), st.highlightHue||0);
      gl.uniform1f(u('u_stHS'),(st.highlightSat||0)/100);
      gl.uniform1f(u('u_stBal'),(st.balance||0)/100);

      /* ── Geometry buffers ── */
      const aPos=gl.getAttribLocation(prog,'a_pos');
      gl.bindBuffer(gl.ARRAY_BUFFER,posB);
      gl.enableVertexAttribArray(aPos); gl.vertexAttribPointer(aPos,2,gl.FLOAT,false,0,0);

      const aTc=gl.getAttribLocation(prog,'a_tc');
      gl.bindBuffer(gl.ARRAY_BUFFER,tcB);
      gl.enableVertexAttribArray(aTc); gl.vertexAttribPointer(aTc,2,gl.FLOAT,false,0,0);

      /* ── Draw & copy to destination ── */
      gl.drawArrays(gl.TRIANGLE_STRIP,0,4);
      gl.flush();

      const dctx=destCanvas.getContext('2d');
      destCanvas.width=w; destCanvas.height=h;
      dctx.drawImage(offscreen,0,0);
      return true;
    }catch(e){
      console.warn('GL renderTo failed:',e); available=false; return false;
    }
  }

  /* Call once after DOM ready */
  init();

  return { get available(){ return available; }, renderTo, canHandleAdj };
})();
