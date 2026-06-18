"use strict";
/* WildmanDesigns — image processing engine */
const clamp=(v,a,b)=>v<a?a:v>b?b:v;
/* ============================================================
   DEVELOP ENGINE  — builds a per-channel LUT then a pixel pass
   ============================================================ */
function buildLUT(adj){
  // curve LUT (256) from control points
  const pts=[...adj.curve].sort((a,b)=>a[0]-b[0]);
  const curve=new Float32Array(256);
  for(let x=0;x<256;x++){
    let i=0; while(i<pts.length-1 && pts[i+1][0]<x) i++;
    const a=pts[i], b=pts[Math.min(i+1,pts.length-1)];
    const t=b[0]===a[0]?0:(x-a[0])/(b[0]-a[0]);
    curve[x]=clamp(a[1]+(b[1]-a[1])*t,0,255)/255;
  }
  const c = 1 + adj.contrast/100;
  const sh=adj.shadows/100, hi=adj.highlights/100;
  const wh=adj.whites/100, bl=adj.blacks/100;
  const lut=new Float32Array(256);
  for(let x=0;x<256;x++){
    let t=x/255;
    // contrast around mid
    t=(t-0.5)*c+0.5;
    // whites/blacks (endpoint shaping)
    t=t+wh*0.5*t*t;            // lift/lower highlights end
    t=t+bl*0.5*(1-t)*(1-t)*-1; // shift blacks end
    // shadows / highlights smooth regions
    t=t+sh*0.5*Math.pow(1-clamp(t,0,1),2);
    t=t-hi*0.5*Math.pow(clamp(t,0,1),2);
    // user curve mapped through current value
    const ci=clamp(Math.round(clamp(t,0,1)*255),0,255);
    t=curve[ci];
    lut[x]=clamp(t,0,1);
  }
  return lut;
}

function processImageData(img, adj){
  const d=img.data, n=d.length;
  const lut=buildLUT(adj);
  const expF=Math.pow(2,adj.exposure);
  const tempF=adj.temp/100, tintF=adj.tint/100;
  const rGain=(1+0.30*tempF)*expF, gGain=(1-0.18*tintF)*expF, bGain=(1-0.30*tempF)*expF;
  const sat=adj.saturation/100, vib=adj.vibrance/100;
  for(let i=0;i<n;i+=4){
    let r=d[i]*rGain, g=d[i+1]*gGain, b=d[i+2]*bGain;
    r=clamp(r,0,255); g=clamp(g,0,255); b=clamp(b,0,255);
    // tonal LUT (per channel)
    r=lut[r|0]*255; g=lut[g|0]*255; b=lut[b|0]*255;
    // saturation + vibrance
    if(sat||vib){
      const luma=0.299*r+0.587*g+0.114*b;
      const mx=Math.max(r,g,b), mn=Math.min(r,g,b);
      const curSat=mx<=0?0:(mx-mn)/mx;            // 0..1
      const f=1+sat+vib*(1-curSat);               // vibrance eases off saturated pixels
      r=luma+(r-luma)*f; g=luma+(g-luma)*f; b=luma+(b-luma)*f;
    }
    d[i]=clamp(r,0,255); d[i+1]=clamp(g,0,255); d[i+2]=clamp(b,0,255);
  }
  // clarity + sharpening (single convolution pass on luminance) if needed
  if(adj.clarity||adj.sharpen) convolveDetail(img, adj.clarity/100, adj.sharpen/100);
  if(adj.dehaze) applyDehaze(img,adj);
  if(adj.hsl) applyHSL(img,adj);
  if(adj.splitTone&&(adj.splitTone.shadowSat||adj.splitTone.highlightSat)) applySplitTone(img,adj);
  if(adj.denoiseL||adj.denoiseC) applyDenoise(img,adj);
  if(adj.rgbCurves) applyRGBCurves(img,adj);
  if(adj.grain) applyGrain(img,adj);
  if(adj.cubeLut) applyCubeLUT(img,adj.cubeLut);
  return img;
}

// unsharp-style local-contrast + sharpening
function convolveDetail(img, clarity, sharpen){
  const {data,width:w,height:h}=img;
  const lum=new Float32Array(w*h);
  for(let i=0,p=0;i<data.length;i+=4,p++) lum[p]=0.299*data[i]+0.587*data[i+1]+0.114*data[i+2];
  // 3x3 box blur of luminance
  const blur=new Float32Array(w*h);
  for(let y=0;y<h;y++)for(let x=0;x<w;x++){
    let s=0,c=0;
    for(let dy=-1;dy<=1;dy++)for(let dx=-1;dx<=1;dx++){
      const xx=x+dx,yy=y+dy; if(xx<0||yy<0||xx>=w||yy>=h)continue;
      s+=lum[yy*w+xx]; c++;
    }
    blur[y*w+x]=s/c;
  }
  const kClar=clarity*0.6, kSharp=sharpen*1.4;
  for(let p=0,i=0;p<lum.length;p++,i+=4){
    const detail=lum[p]-blur[p];
    const add=detail*(kClar+kSharp);
    if(add!==0){
      const ratio=lum[p]>1?(lum[p]+add)/lum[p]:1;
      data[i]=clamp(data[i]*ratio,0,255);
      data[i+1]=clamp(data[i+1]*ratio,0,255);
      data[i+2]=clamp(data[i+2]*ratio,0,255);
    }
  }
}

/* ---- HSL color helpers ---- */
function rgb2hsl(r,g,b){
  r/=255;g/=255;b/=255;
  const mx=Math.max(r,g,b),mn=Math.min(r,g,b),d=mx-mn;
  let h=0,s=0,l=(mx+mn)/2;
  if(d>0){
    s=d/(1-Math.abs(2*l-1));
    if(mx===r)h=((g-b)/d+6)%6;
    else if(mx===g)h=(b-r)/d+2;
    else h=(r-g)/d+4;
    h*=60;
  }
  return [h,s,l];
}
function hsl2rgb(h,s,l){
  const c=(1-Math.abs(2*l-1))*s;
  const x=c*(1-Math.abs((h/60)%2-1));
  const m=l-c/2;
  let r=0,g=0,b=0;
  if(h<60){r=c;g=x;}else if(h<120){r=x;g=c;}
  else if(h<180){g=c;b=x;}else if(h<240){g=x;b=c;}
  else if(h<300){r=x;b=c;}else{r=c;b=x;}
  return [(r+m)*255,(g+m)*255,(b+m)*255];
}
function hslTentWeight(pixH,centerH,hw){
  let d=Math.abs(pixH-centerH);
  if(d>180)d=360-d;
  return clamp(1-d/hw,0,1);
}
function applyHSL(img,adj){
  const d=img.data,n=d.length;
  const ranges=[
    {key:'red',h:0,hw:35},{key:'orange',h:30,hw:25},{key:'yellow',h:60,hw:25},
    {key:'green',h:120,hw:35},{key:'aqua',h:180,hw:30},{key:'blue',h:240,hw:35},
    {key:'purple',h:280,hw:30},{key:'magenta',h:330,hw:35}
  ];
  for(let i=0;i<n;i+=4){
    let r=d[i],g=d[i+1],b=d[i+2];
    const [h,s,l]=rgb2hsl(r,g,b);
    if(s<0.01){continue;}
    let dh=0,ds=0,dl=0;
    for(const rng of ranges){
      const a=adj.hsl[rng.key]; if(!a)continue;
      const w=hslTentWeight(h,rng.h,rng.hw);
      if(w<=0)continue;
      dh+=a.h*w; ds+=a.s/100*w; dl+=a.l/100*w;
    }
    if(!dh&&!ds&&!dl)continue;
    let nh=(h+dh+360)%360, ns=clamp(s+ds,0,1), nl=clamp(l+dl,0,1);
    const [nr,ng,nb]=hsl2rgb(nh,ns,nl);
    d[i]=clamp(nr,0,255); d[i+1]=clamp(ng,0,255); d[i+2]=clamp(nb,0,255);
  }
}
function applySplitTone(img,adj){
  const st=adj.splitTone; if(!st)return;
  const d=img.data,n=d.length;
  const sHue=st.shadowHue,sSat=st.shadowSat/100;
  const hHue=st.highlightHue,hSat=st.highlightSat/100;
  const bal=st.balance/100;
  if(!sSat&&!hSat)return;
  for(let i=0;i<n;i+=4){
    const r=d[i],g=d[i+1],b=d[i+2];
    const lum=(0.299*r+0.587*g+0.114*b)/255;
    const hw=clamp(lum*(1+bal),0,1);
    const sw=clamp((1-lum)*(1-bal),0,1);
    if(sSat&&sw>0){
      const [sr,sg,sb]=hsl2rgb(sHue,sSat,0.5);
      d[i]  =clamp(d[i]  +(sr-128)*sw*0.4,0,255);
      d[i+1]=clamp(d[i+1]+(sg-128)*sw*0.4,0,255);
      d[i+2]=clamp(d[i+2]+(sb-128)*sw*0.4,0,255);
    }
    if(hSat&&hw>0){
      const [hr2,hg2,hb2]=hsl2rgb(hHue,hSat,0.5);
      d[i]  =clamp(d[i]  +(hr2-128)*hw*0.4,0,255);
      d[i+1]=clamp(d[i+1]+(hg2-128)*hw*0.4,0,255);
      d[i+2]=clamp(d[i+2]+(hb2-128)*hw*0.4,0,255);
    }
  }
}
function applyDehaze(img,adj){
  const v=adj.dehaze/100; if(!v)return;
  const d=img.data,n=d.length;
  const c=1+v*0.5;
  for(let i=0;i<n;i+=4){
    d[i]  =clamp((d[i]  /255-0.5)*c+0.5,0,1)*255;
    d[i+1]=clamp((d[i+1]/255-0.5)*c+0.5,0,1)*255;
    d[i+2]=clamp((d[i+2]/255-0.5)*c+0.5,0,1)*255;
  }
}
function separableBoxBlur(src,w,h,r){
  const out=new Float32Array(src.length);
  const tmp=new Float32Array(src.length);
  for(let y=0;y<h;y++){
    for(let x=0;x<w;x++){
      let s=0,c=0;
      for(let dx=-r;dx<=r;dx++){const xx=clamp(x+dx,0,w-1);s+=src[y*w+xx];c++;}
      tmp[y*w+x]=s/c;
    }
  }
  for(let y=0;y<h;y++){
    for(let x=0;x<w;x++){
      let s=0,c=0;
      for(let dy=-r;dy<=r;dy++){const yy=clamp(y+dy,0,h-1);s+=tmp[yy*w+x];c++;}
      out[y*w+x]=s/c;
    }
  }
  return out;
}
function applyDenoise(img,adj){
  const lv=adj.denoiseL/100, cv=adj.denoiseC/100;
  if(!lv&&!cv)return;
  const {data:d,width:w,height:h}=img;
  const n=w*h;
  const r=Math.max(1,Math.round(Math.max(lv,cv)*5));
  const eps=0.04*(1-Math.max(lv,cv)*0.5);
  // Guided filter: edge-preserving, much better than box blur
  function guided(src,guide){
    const mG=separableBoxBlur(guide,w,h,r), mS=separableBoxBlur(src,w,h,r);
    const g2=new Float32Array(n), gs=new Float32Array(n);
    for(let i=0;i<n;i++){g2[i]=guide[i]*guide[i]; gs[i]=guide[i]*src[i];}
    const vG=separableBoxBlur(g2,w,h,r), cGS=separableBoxBlur(gs,w,h,r);
    const a=new Float32Array(n), b=new Float32Array(n);
    for(let i=0;i<n;i++){
      const vv=vG[i]-mG[i]*mG[i], cc=cGS[i]-mG[i]*mS[i];
      a[i]=cc/(vv+eps); b[i]=mS[i]-a[i]*mG[i];
    }
    const mA=separableBoxBlur(a,w,h,r), mB=separableBoxBlur(b,w,h,r);
    const out=new Float32Array(n);
    for(let i=0;i<n;i++) out[i]=clamp(mA[i]*guide[i]+mB[i],0,1);
    return out;
  }
  if(lv>0){
    const lum=new Float32Array(n);
    for(let i=0,p=0;i<d.length;i+=4,p++) lum[p]=(0.299*d[i]+0.587*d[i+1]+0.114*d[i+2])/255;
    const fil=guided(lum,lum);
    for(let p=0,i=0;p<n;p++,i+=4){
      const ratio=lum[p]>0.001?fil[p]/lum[p]:1, t=lv;
      d[i]  =clamp(d[i]  *((1-t)+t*ratio),0,255);
      d[i+1]=clamp(d[i+1]*((1-t)+t*ratio),0,255);
      d[i+2]=clamp(d[i+2]*((1-t)+t*ratio),0,255);
    }
  }
  if(cv>0){
    const lum=new Float32Array(n),R=new Float32Array(n),G2=new Float32Array(n),B=new Float32Array(n);
    for(let i=0,p=0;i<d.length;i+=4,p++){
      lum[p]=(0.299*d[i]+0.587*d[i+1]+0.114*d[i+2])/255;
      R[p]=d[i]/255; G2[p]=d[i+1]/255; B[p]=d[i+2]/255;
    }
    const fR=guided(R,lum), fG=guided(G2,lum), fB=guided(B,lum);
    for(let p=0,i=0;p<n;p++,i+=4){
      d[i]  =clamp(d[i]  *(1-cv)+fR[p]*cv*255,0,255);
      d[i+1]=clamp(d[i+1]*(1-cv)+fG[p]*cv*255,0,255);
      d[i+2]=clamp(d[i+2]*(1-cv)+fB[p]*cv*255,0,255);
    }
  }
}
function applyGrain(img,adj){
  const amt=adj.grain; if(!amt)return;
  const d=img.data,n=d.length,strength=(amt/100)*35,w=img.width;
  for(let i=0,p=0;i<n;i+=4,p++){
    const x=p%w,y=(p/w)|0;
    let h=((x*1234567+y*7654321)^0xdeadbeef)>>>0;
    h=(h^(h>>>16))*0x45d9f3b>>>0; h=(h^(h>>>16))>>>0;
    const noise=((h&0xffff)/65535-0.5)*strength;
    d[i]=clamp(d[i]+noise,0,255); d[i+1]=clamp(d[i+1]+noise,0,255); d[i+2]=clamp(d[i+2]+noise,0,255);
  }
}
function parseCubeLUT(text){
  const lines=text.split(/\r?\n/); let size=0; const data=[];
  for(const raw of lines){
    const line=raw.trim(); if(!line||line.startsWith('#'))continue;
    if(line.startsWith('LUT_3D_SIZE')){size=parseInt(line.split(/\s+/)[1]);continue;}
    if(line.startsWith('DOMAIN_')||line.startsWith('TITLE')||line.startsWith('LUT_1D'))continue;
    const parts=line.split(/\s+/);
    if(parts.length>=3){data.push(parseFloat(parts[0]),parseFloat(parts[1]),parseFloat(parts[2]));}
  }
  if(!size||data.length!==size*size*size*3)return null;
  return {size,table:new Float32Array(data)};
}
function applyCubeLUT(img,lut){
  if(!lut||!lut.table)return;
  const {size,table}=lut,n2=size-1,s2=size*size;
  const d=img.data;
  function lerp(a,b,t){return a+(b-a)*t;}
  for(let i=0;i<d.length;i+=4){
    const r=d[i]/255,g=d[i+1]/255,b2=d[i+2]/255;
    const ri=Math.min(r*n2,n2-1e-4),gi=Math.min(g*n2,n2-1e-4),bi=Math.min(b2*n2,n2-1e-4);
    const r0=ri|0,g0=gi|0,b0=bi|0,r1=r0+1,g1=g0+1,b1=b0+1;
    const fr=ri-r0,fg=gi-g0,fb=bi-b0;
    function idx(rr,gg,bb){return(bb*s2+gg*size+rr)*3;}
    for(let ch=0;ch<3;ch++){
      d[i+ch]=clamp(lerp(
        lerp(lerp(table[idx(r0,g0,b0)+ch],table[idx(r1,g0,b0)+ch],fr),
             lerp(table[idx(r0,g1,b0)+ch],table[idx(r1,g1,b0)+ch],fr),fg),
        lerp(lerp(table[idx(r0,g0,b1)+ch],table[idx(r1,g0,b1)+ch],fr),
             lerp(table[idx(r0,g1,b1)+ch],table[idx(r1,g1,b1)+ch],fr),fg),fb)*255,0,255);
    }
  }
}
function buildChannelLUT(points){
  const pts=[...points].sort((a,b)=>a[0]-b[0]);
  const lut=new Float32Array(256);
  for(let x=0;x<256;x++){
    let i=0;while(i<pts.length-1&&pts[i+1][0]<x)i++;
    const a=pts[i],b=pts[Math.min(i+1,pts.length-1)];
    const t=b[0]===a[0]?0:(x-a[0])/(b[0]-a[0]);
    lut[x]=clamp(a[1]+(b[1]-a[1])*t,0,255);
  }
  return lut;
}
function applyRGBCurves(img,adj){
  const rc=adj.rgbCurves; if(!rc)return;
  const isIdentity=pts=>{
    if(pts.length!==2)return false;
    return pts[0][0]===0&&pts[0][1]===0&&pts[1][0]===255&&pts[1][1]===255;
  };
  if(isIdentity(rc.r)&&isIdentity(rc.g)&&isIdentity(rc.b))return;
  const rl=buildChannelLUT(rc.r),gl=buildChannelLUT(rc.g),bl=buildChannelLUT(rc.b);
  const d=img.data,n=d.length;
  for(let i=0;i<n;i+=4){
    d[i]  =rl[clamp(d[i]|0,0,255)];
    d[i+1]=gl[clamp(d[i+1]|0,0,255)];
    d[i+2]=bl[clamp(d[i+2]|0,0,255)];
  }
}
/* ---- EXIF parser ---- */
function extractExif(buffer){
  const view=new DataView(buffer);
  if(view.getUint16(0)!==0xFFD8)return {};
  const len=buffer.byteLength;
  let off=2;
  while(off+4<=len){
    const marker=view.getUint16(off); off+=2;
    if(marker===0xFFE1){
      const segLen=view.getUint16(off); off+=2;
      if(segLen<8)break;
      const exifStart=off;
      if(view.getUint32(off)!==0x45786966)break;
      const tiffOff=off+6;
      const le=view.getUint16(tiffOff)===0x4949;
      if(view.getUint16(tiffOff+2,le)!==42)break;
      const ifd0=tiffOff+view.getUint32(tiffOff+4,le);
      const result={};
      function readIFD(ifdOff){
        if(ifdOff+2>len)return;
        const count=view.getUint16(ifdOff,le);
        for(let i=0;i<count;i++){
          const base=ifdOff+2+i*12;
          if(base+12>len)break;
          const tag=view.getUint16(base,le);
          const type=view.getUint16(base+2,le);
          const cnt=view.getUint32(base+4,le);
          const valOff=base+8;
          const readStr=(o,l)=>{let s='';for(let j=0;j<l&&j+o<len;j++){const c=view.getUint8(o+j);if(!c)break;s+=String.fromCharCode(c);}return s.trim();};
          const readRat=(o,le2)=>{const n=view.getUint32(o,le2),d=view.getUint32(o+4,le2);return d?n/d:0;};
          if(tag===0x010F){const o=cnt>4?view.getUint32(valOff,le)+tiffOff:valOff;result.make=readStr(o,cnt);}
          else if(tag===0x0110){const o=cnt>4?view.getUint32(valOff,le)+tiffOff:valOff;result.model=readStr(o,cnt);}
          else if(tag===0x829A){const o=view.getUint32(valOff,le)+tiffOff;const n=view.getUint32(o,le),d=view.getUint32(o+4,le);result.exposureTime=d?n+'/'+d:'';}
          else if(tag===0x829D){const o=view.getUint32(valOff,le)+tiffOff;result.fNumber=readRat(o,le).toFixed(1);}
          else if(tag===0x8827){result.iso=(cnt<=4&&type===3)?view.getUint16(valOff,le):view.getUint32(view.getUint32(valOff,le)+tiffOff,le);}
          else if(tag===0x9003){const o=cnt>4?view.getUint32(valOff,le)+tiffOff:valOff;result.dateTime=readStr(o,cnt);}
          else if(tag===0x920A){const o=view.getUint32(valOff,le)+tiffOff;result.focalLength=readRat(o,le).toFixed(0)+'mm';}
          else if(tag===0x8769){readIFD(view.getUint32(valOff,le)+tiffOff);}
        }
      }
      readIFD(ifd0);
      return result;
    }
    if((marker&0xFF00)!==0xFF00)break;
    off+=view.getUint16(off);
  }
  return {};
}
