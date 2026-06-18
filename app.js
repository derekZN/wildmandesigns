"use strict";
/* WildmanDesigns — main application logic */
"use strict";
/* ============================================================
   WildmanDesigns — photo develop engine (vanilla JS)
   All processing is local & non-destructive. Originals are never modified.
   ============================================================ */

function lockPortrait() {
  if (screen.orientation && screen.orientation.lock) {
    screen.orientation.lock('portrait').catch(() => {});
  }
}
lockPortrait();
document.addEventListener('click', lockPortrait, { once: true });

if ('serviceWorker' in navigator) {
  // the very first controllerchange (no controller -> new worker) is just the initial
  // install claiming the page, not a genuine update — skip showing the banner for it
  let skipFirstControllerChange = !navigator.serviceWorker.controller;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (skipFirstControllerChange) { skipFirstControllerChange = false; return; }
    document.getElementById('updateBanner').classList.add('show');
  });
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('./sw.js').catch(err => console.warn('SW registration failed', err));
  });
}

const $ = s => document.querySelector(s);
const $$ = s => [...document.querySelectorAll(s)];

const DEFAULT_ADJ = {
  exposure:0, contrast:0, highlights:0, shadows:0, whites:0, blacks:0,
  temp:0, tint:0, vibrance:0, saturation:0, clarity:0, sharpen:0,
  curve:[[0,0],[255,255]],
  crop:null,   // {l,t,r,b} normalised 0-1 of the rotated image bounds
  angle:0,     // straighten degrees, -45..+45
  flipH:false, // horizontal mirror
  dehaze:0,
  denoiseL:0,
  denoiseC:0,
  distort:0,
  vignette2:0,
  vertPersp:0,
  horizPersp:0,
  hsl:{red:{h:0,s:0,l:0},orange:{h:0,s:0,l:0},yellow:{h:0,s:0,l:0},green:{h:0,s:0,l:0},aqua:{h:0,s:0,l:0},blue:{h:0,s:0,l:0},purple:{h:0,s:0,l:0},magenta:{h:0,s:0,l:0}},
  splitTone:{shadowHue:0,shadowSat:0,highlightHue:0,highlightSat:0,balance:0},
  rgbCurves:{r:[[0,0],[255,255]],g:[[0,0],[255,255]],b:[[0,0],[255,255]]},
};

function normalizeAdj(adj){
  const def=DEFAULT_ADJ;
  if(!adj.hsl) adj.hsl=structuredClone(def.hsl);
  if(!adj.splitTone) adj.splitTone=structuredClone(def.splitTone);
  if(!adj.rgbCurves) adj.rgbCurves=structuredClone(def.rgbCurves);
  ['dehaze','denoiseL','denoiseC','distort','vignette2','vertPersp','horizPersp'].forEach(k=>{ if(adj[k]==null) adj[k]=0; });
  return adj;
}

const state = {
  photos: [],
  selId: null,
  presets: [],
  showBefore: false,
  clipboard: null,
  activeMask: -1,
  view: {mode:'fit', panX:0, panY:0},
  brush: {size:40, hardness:60, flow:80, erasing:false},
  spotMode: false,
  selSpot: null,
  spotDrag: null,
  cropMode: false,
  cropSnap: null,   // snapshot for cancel
  _cropView: null,  // {scale,rotW,rotH,cw,ch} set during renderStageTransform
  selectMode: false,
  multiSel: new Set(),
  exportQuality: 0.92,
  exportFormat: 'jpeg',
  sort:'order',
  filterMode:'all',
  collections:[],
  activeCollection:null,
  compareMode:false,
  compareSplitX:0.5,
  watermark:{enabled:false,text:'',position:'br',opacity:0.7,size:3},
  exportResize:{enabled:false,longEdge:2000},
  curveChannel:'rgb',
};
const MASK_ADJ = {exposure:0, contrast:0, saturation:0, temp:0};
let uid = 1, maskUid = 1, spotUid = 1;
let cropHandleDrag = null;

/* ---------- helpers ---------- */
function toast(msg){ const t=$('#toast'); t.textContent=msg; t.classList.add('show');
  clearTimeout(t._t); t._t=setTimeout(()=>t.classList.remove('show'),1900); }
function busy(on,label){ $('#busyLbl').textContent=label||'Working…'; $('#busy').classList.toggle('show',on); }
const sel=()=> state.photos.find(p=>p.id===state.selId)||null;
const wait=ms=>new Promise(r=>setTimeout(r,ms));

/* ============================================================
   IMPORT — dual mode: Electron native dialogs OR browser <input>
   ============================================================ */
const IS_ELECTRON = typeof window.safelight !== 'undefined';

// button wiring
$('#importBtn').onclick    = () => IS_ELECTRON ? window.safelight.openFiles()   : $('#file').click();
$('#importFolderBtn').onclick = () => IS_ELECTRON ? window.safelight.openFolder() : toast('Folder import requires the desktop app');
$('#drop').onclick         = () => IS_ELECTRON ? window.safelight.openFiles()   : $('#file').click();
$('#file').onchange        = e => addFiles([...e.target.files]);  // browser fallback

// Electron: main process sends decoded base64 file objects
if(IS_ELECTRON){
  window.safelight.onImportFiles(async (electronFiles) => {
    // convert base64 → Blob → File objects for the shared addFiles path
    const blobs = electronFiles.map(ef => {
      const bin  = atob(ef.data);
      const arr  = new Uint8Array(bin.length);
      for(let i=0;i<bin.length;i++) arr[i]=bin.charCodeAt(i);
      const mime = ef.ext==='.png'?'image/png':ef.ext==='.webp'?'image/webp':'image/jpeg';
      return new File([arr], ef.name, { type: mime });
    });
    await addFiles(blobs);
  });
}

const stage=$('#stage');
['dragover','dragenter'].forEach(ev=>stage.addEventListener(ev,e=>{e.preventDefault();}));
stage.addEventListener('drop',e=>{e.preventDefault();
  const fs=[...e.dataTransfer.files].filter(f=>isSupportedFile(f));
  if(fs.length) addFiles(fs);
});

/* ============================================================
   RAW FILE SUPPORT — extracts the embedded full-res JPEG from
   TIFF-based RAW formats: NEF, CR2, ARW, DNG, ORF, RW2, PEF, SRW
   ============================================================ */
const RAW_EXT = /\.(nef|cr2|arw|dng|orf|rw2|pef|srw)$/i;
const HEIC_EXT = /\.(heic|heif)$/i;
function isRawFile(f){ return RAW_EXT.test(f.name); }
function isSupportedFile(f){ return /image\/(jpeg|png|webp)/.test(f.type) || isRawFile(f) || HEIC_EXT.test(f.name); }

function extractEmbeddedJpeg(buffer){
  const view = new DataView(buffer);
  if(buffer.byteLength < 8) return null;
  const le = view.getUint16(0) === 0x4949; // 'II' = little-endian
  if(view.getUint16(2, le) !== 42) return null; // not TIFF

  const jpegs = [];
  const visited = new Set();
  const typeSizes = [0,1,1,2,4,8,1,1,2,4,8,4,8];

  function parseIFD(offset){
    if(!offset || offset + 2 > buffer.byteLength || visited.has(offset)) return;
    visited.add(offset);
    const count = view.getUint16(offset, le);
    if(count > 512) return; // sanity cap
    let jpegOff = 0, jpegLen = 0;
    const subOffsets = [];

    for(let i = 0; i < count; i++){
      const base = offset + 2 + i * 12;
      if(base + 12 > buffer.byteLength) break;
      const tag  = view.getUint16(base, le);
      const type = view.getUint16(base + 2, le);
      const cnt  = view.getUint32(base + 4, le);
      const raw32 = view.getUint32(base + 8, le);
      const tsize = typeSizes[Math.min(type, 12)] || 1;
      const totalBytes = tsize * cnt;

      if(tag === 0x0201){ jpegOff = raw32; }             // JPEGInterchangeFormat
      else if(tag === 0x0202){ jpegLen = raw32; }        // JPEGInterchangeFormatLength
      else if(tag === 0x014A){                           // SubIFD pointer(s)
        if(totalBytes <= 4){ subOffsets.push(raw32); }
        else{ for(let j = 0; j < Math.min(cnt, 8); j++){
          const o = raw32 + j * 4;
          if(o + 4 <= buffer.byteLength) subOffsets.push(view.getUint32(o, le));
        }}
      }
    }

    if(jpegOff && jpegLen && jpegOff + jpegLen <= buffer.byteLength){
      // Confirm JPEG SOI marker (FF D8)
      if(view.getUint8(jpegOff) === 0xFF && view.getUint8(jpegOff + 1) === 0xD8){
        jpegs.push({ offset: jpegOff, length: jpegLen });
      }
    }

    for(const sub of subOffsets) parseIFD(sub);
    // follow IFD chain
    const nextOff = offset + 2 + count * 12;
    if(nextOff + 4 <= buffer.byteLength){
      const next = view.getUint32(nextOff, le);
      if(next && next < buffer.byteLength) parseIFD(next);
    }
  }

  parseIFD(view.getUint32(4, le));
  if(!jpegs.length) return null;
  // pick the largest JPEG (= full-res preview)
  jpegs.sort((a, b) => b.length - a.length);
  const best = jpegs[0];
  return buffer.slice(best.offset, best.offset + best.length);
}

// Fallback for cameras whose IFD layout the tag walker above doesn't match:
// scan the raw bytes for JPEG SOI/EOI markers directly and keep the largest one found.
function scanForJpeg(buffer){
  const view=new DataView(buffer);
  const len=buffer.byteLength;
  let bestOff=-1, bestLen=0, i=0;
  while(i<len-3){
    if(view.getUint8(i)===0xFF && view.getUint8(i+1)===0xD8 && view.getUint8(i+2)===0xFF){
      let j=i+2, found=false;
      while(j<len-1){
        if(view.getUint8(j)===0xFF && view.getUint8(j+1)===0xD9){
          const length=j+2-i;
          if(length>bestLen){ bestLen=length; bestOff=i; }
          i=j+2; found=true; break;
        }
        j++;
      }
      if(!found) break;
    } else { i++; }
  }
  return bestOff<0 ? null : buffer.slice(bestOff,bestOff+bestLen);
}

async function loadRawBitmap(file){
  const buffer = await file.arrayBuffer();
  const jpegBuf = extractEmbeddedJpeg(buffer) || scanForJpeg(buffer);
  if(!jpegBuf) throw new Error('No embedded JPEG preview found in ' + file.name);
  const blob = new Blob([jpegBuf], { type: 'image/jpeg' });
  return createImageBitmap(blob, { imageOrientation: 'from-image' });
}

async function addFiles(files){
  const skipped=files.filter(f=>!isSupportedFile(f)).map(f=>f.name);
  files=files.filter(f=>isSupportedFile(f));
  if(!files.length){ toast('Unsupported format — use JPEG, PNG, WebP or RAW (NEF/CR2/ARW/DNG/ORF)'); return; }
  busy(true,'Importing '+files.length+' photo'+(files.length>1?'s':''));
  let added=0; const failed=[...skipped];
  for(const f of files){
    try{
      const bmp = isRawFile(f)
        ? await loadRawBitmap(f)
        : HEIC_EXT.test(f.name) ? await createImageBitmap(f).catch(async()=>{
            const ab=await f.arrayBuffer();
            const blob=new Blob([ab],{type:'image/jpeg'});
            return createImageBitmap(blob);
          })
        : await createImageBitmap(f,{imageOrientation:'from-image'});
      const p={ id:uid++, name:f.name, bitmap:bmp, w:bmp.width, h:bmp.height,
        adj:structuredClone(DEFAULT_ADJ), masks:[], spots:[],
        thumb:document.createElement('canvas'),
        _undo:[], _redo:[],
        rating:0, flag:0, exif:{}, collections:new Set() };
      makeThumb(p);
      // Try to extract EXIF data
      try{
        if(isRawFile(f)){
          // For RAW files, EXIF lives in the embedded JPEG — parse the raw buffer
          const ab=await f.arrayBuffer();
          const jpegBuf=extractEmbeddedJpeg(ab)||scanForJpeg(ab);
          if(jpegBuf) p.exif=extractExif(jpegBuf);
        } else if(!HEIC_EXT.test(f.name)){
          // JPEG/PNG/WebP — read just the first 64 KB (enough for EXIF app segments)
          const ab=await f.slice(0,65536).arrayBuffer();
          p.exif=extractExif(ab);
        }
      }catch{}
      state.photos.push(p);
      if(!IS_ELECTRON) idbPut('files',{id:p.id,name:p.name,blob:f});
      added++;
    }catch(err){ console.warn('decode failed',f.name,err); failed.push(f.name); }
    await wait(0);
  }
  if(!state.selId && state.photos.length){ state.selId=state.photos[0].id; onPhotoChanged(); }
  busy(false);
  renderThumbs(); renderStage(); renderLooks(); updateChrome();
  scheduleSessionSave();
  if(failed.length){
    toast(added+' loaded, '+failed.length+' skipped: '+failed.slice(0,3).join(', ')+(failed.length>3?'…':''));
  } else {
    toast(added+' photo'+(added!==1?'s':'')+' loaded');
  }
}

function makeThumb(p){
  const c=p.thumb, tw=Math.min(480, p.w), th=Math.min(Math.round(tw*p.h/p.w), p.h);
  c.width=tw; c.height=th;
  const tx=c.getContext('2d');
  tx.imageSmoothingEnabled=true; tx.imageSmoothingQuality='high';
  tx.drawImage(p.bitmap,0,0,tw,th);
}

/* ---- lens corrections applied to a canvas ---- */
function applyLensCorrections(canvas,adj){
  const k=adj.distort/100, v2=adj.vignette2/100;
  if(!k&&!v2)return canvas;
  const w=canvas.width,h=canvas.height;
  const ctx=canvas.getContext('2d',{willReadFrequently:true});
  const src=ctx.getImageData(0,0,w,h);
  const dst=ctx.createImageData(w,h);
  const sd=src.data,dd=dst.data;
  const cx=w/2,cy=h/2;
  const scaleN=Math.max(cx,cy);
  for(let y=0;y<h;y++)for(let x=0;x<w;x++){
    const nx=(x-cx)/scaleN, ny=(y-cy)/scaleN;
    const r2=nx*nx+ny*ny;
    let sx,sy;
    if(k){
      const factor=1+k*r2;
      sx=(nx/factor)*scaleN+cx;
      sy=(ny/factor)*scaleN+cy;
    } else {sx=x;sy=y;}
    const x0=Math.floor(sx),y0=Math.floor(sy);
    const x1=x0+1,y1=y0+1;
    const fx=sx-x0,fy=sy-y0;
    const di=(y*w+x)*4;
    if(x0<0||y0<0||x1>=w||y1>=h){
      dd[di+3]=0;continue;
    }
    const i00=(y0*w+x0)*4,i10=(y0*w+x1)*4,i01=(y1*w+x0)*4,i11=(y1*w+x1)*4;
    for(let c=0;c<3;c++){
      dd[di+c]=clamp(
        sd[i00+c]*(1-fx)*(1-fy)+sd[i10+c]*fx*(1-fy)+
        sd[i01+c]*(1-fx)*fy  +sd[i11+c]*fx*fy, 0,255);
    }
    dd[di+3]=255;
    if(v2){
      const vf=clamp(1+v2*r2,0,2);
      dd[di]=clamp(dd[di]*vf,0,255);
      dd[di+1]=clamp(dd[di+1]*vf,0,255);
      dd[di+2]=clamp(dd[di+2]*vf,0,255);
    }
  }
  ctx.putImageData(dst,0,0);
  return canvas;
}
function applyPerspective(canvas,adj){
  const vp=adj.vertPersp/100, hp=adj.horizPersp/100;
  if(!vp&&!hp)return canvas;
  const w=canvas.width,h=canvas.height;
  const ctx=canvas.getContext('2d',{willReadFrequently:true});
  const src=ctx.getImageData(0,0,w,h);
  const dst=ctx.createImageData(w,h);
  const sd=src.data,dd=dst.data;
  for(let y=0;y<h;y++){
    const ny=2*y/h-1;
    const scaleV=vp?1/(1+vp*ny):1;
    for(let x=0;x<w;x++){
      const nx=2*x/w-1;
      const scaleH=hp?1/(1+hp*nx):1;
      const sx=(nx/scaleH+1)/2*w;
      const sy=(ny/scaleV+1)/2*h;
      const x0=Math.floor(sx),y0=Math.floor(sy);
      const x1=x0+1,y1=y0+1;
      const fx=sx-x0,fy=sy-y0;
      const di=(y*w+x)*4;
      if(x0<0||y0<0||x1>=w||y1>=h){dd[di+3]=0;continue;}
      const i00=(y0*w+x0)*4,i10=(y0*w+x1)*4,i01=(y1*w+x0)*4,i11=(y1*w+x1)*4;
      for(let c=0;c<3;c++){
        dd[di+c]=clamp(
          sd[i00+c]*(1-fx)*(1-fy)+sd[i10+c]*fx*(1-fy)+
          sd[i01+c]*(1-fx)*fy  +sd[i11+c]*fx*fy, 0,255);
      }
      dd[di+3]=255;
    }
  }
  ctx.putImageData(dst,0,0);
  return canvas;
}
/* ---- watermark rendering ---- */
function applyWatermark(canvas,wm){
  if(!wm||!wm.enabled||!wm.text)return canvas;
  const ctx=canvas.getContext('2d');
  const W=canvas.width,H=canvas.height;
  const long=Math.max(W,H);
  const fsize=Math.round(long*wm.size/100);
  ctx.save();
  ctx.font=`600 ${fsize}px sans-serif`;
  ctx.globalAlpha=wm.opacity||0.7;
  ctx.fillStyle='#ffffff';
  ctx.shadowColor='rgba(0,0,0,0.6)';
  ctx.shadowBlur=fsize*0.3;
  const metrics=ctx.measureText(wm.text);
  const tw=metrics.width, th=fsize;
  const pad=fsize*0.5;
  let x,y;
  switch(wm.position){
    case 'tl':x=pad;y=pad+th;break;
    case 'tr':x=W-tw-pad;y=pad+th;break;
    case 'bl':x=pad;y=H-pad;break;
    case 'center':x=(W-tw)/2;y=(H+th)/2;break;
    default:x=W-tw-pad;y=H-pad;
  }
  ctx.fillText(wm.text,x,y);
  ctx.restore();
  return canvas;
}
/* ---- getSortedFilteredPhotos ---- */
function getSortedFilteredPhotos(){
  let list=state.photos;
  if(state.activeCollection!=null) list=list.filter(p=>p.collections&&p.collections.has(state.activeCollection));
  if(state.filterMode==='picks') list=list.filter(p=>p.flag===1);
  else if(state.filterMode==='rejects') list=list.filter(p=>p.flag===-1);
  else if(state.filterMode==='rated') list=list.filter(p=>p.rating>=3);
  if(state.sort==='name') list=[...list].sort((a,b)=>a.name.localeCompare(b.name));
  else if(state.sort==='rating-desc') list=[...list].sort((a,b)=>b.rating-a.rating);
  else if(state.sort==='rating-asc') list=[...list].sort((a,b)=>a.rating-b.rating);
  return list;
}

/* ---------- mask weight (normalized image coords) ---------- */
function maskWeight(m, nx, ny){
  if(m.type==='brush'){
    // sample the mask's Float32 buffer (stored at photo resolution)
    if(!m._buf) return 0;
    const px=clamp(Math.round(nx*m._bw),0,m._bw-1);
    const py=clamp(Math.round(ny*m._bh),0,m._bh-1);
    const w=m._buf[py*m._bw+px];
    return m.inverted ? 1-w : w;
  }
  const f = clamp(m.feather/100, 0.01, 1);
  if(m.type==='radial'){
    const dx=(nx-m.cx)/Math.max(m.rx,1e-4), dy=(ny-m.cy)/Math.max(m.ry,1e-4);
    const d=Math.sqrt(dx*dx+dy*dy);
    let w = d>=1 ? 0 : clamp((1-d)/f, 0, 1);
    return m.inverted ? 1-w : w;
  } else {
    const ax=m.x1,ay=m.y1,bx=m.x2,by=m.y2;
    const vx=bx-ax, vy=by-ay; const len2=vx*vx+vy*vy||1e-6;
    const t=((nx-ax)*vx+(ny-ay)*vy)/len2;
    let w = clamp(1 - t, 0, 1);
    return m.inverted ? 1-w : w;
  }
}

/* ---------- apply local masks over a rendered region ---------- */
function applyMasks(img, p, sx, sy, sw, sh){
  if(!p.masks.length) return;
  const {data,width:cw,height:ch}=img;
  for(const m of p.masks){
    const ma=m.adj;
    if(!(ma.exposure||ma.contrast||ma.saturation||ma.temp)) continue;
    // for brush: pre-downscale the buffer to canvas resolution for speed
    let brushSampler=null;
    if(m.type==='brush' && m._buf){
      brushSampler={buf:m._buf,bw:m._bw,bh:m._bh,inv:m.inverted};
    }
    const expF=Math.pow(2,ma.exposure);
    const c=1+ma.contrast/100, sat=ma.saturation/100, tF=ma.temp/100;
    const rG=1+0.30*tF, bG=1-0.30*tF;
    for(let py=0,i=0;py<ch;py++){
      const ny=(sy+py/ch*sh)/p.h;
      for(let px=0;px<cw;px++,i+=4){
        const nx=(sx+px/cw*sw)/p.w;
        let w;
        if(brushSampler){
          const bpx=clamp(Math.round(nx*brushSampler.bw),0,brushSampler.bw-1);
          const bpy=clamp(Math.round(ny*brushSampler.bh),0,brushSampler.bh-1);
          w=brushSampler.buf[bpy*brushSampler.bw+bpx];
          if(brushSampler.inv) w=1-w;
        } else {
          w=maskWeight(m,nx,ny);
        }
        if(w<=0) continue;
        let r=data[i],g=data[i+1],b=data[i+2];
        let nr=r*expF*rG, ng=g*expF, nb=b*expF*bG;
        nr=(nr/255-0.5)*c+0.5; ng=(ng/255-0.5)*c+0.5; nb=(nb/255-0.5)*c+0.5;
        nr*=255; ng*=255; nb*=255;
        if(sat){ const lu=0.299*nr+0.587*ng+0.114*nb; const sf=1+sat;
          nr=lu+(nr-lu)*sf; ng=lu+(ng-lu)*sf; nb=lu+(nb-lu)*sf; }
        data[i]  =clamp(r+(nr-r)*w,0,255);
        data[i+1]=clamp(g+(ng-g)*w,0,255);
        data[i+2]=clamp(b+(nb-b)*w,0,255);
      }
    }
  }
}

/* ---------- apply spot removal (feathered clone stamp) over rendered region ---------- */
function applySpots(img, p, sx, sy, sw, sh){
  if(!p.spots||!p.spots.length) return;
  const {data,width:cw,height:ch}=img;
  for(const spot of p.spots){
    // convert normalised image coords → canvas pixel coords
    const dstCx=(spot.cx*p.w-sx)/sw*cw, dstCy=(spot.cy*p.h-sy)/sh*ch;
    const srcCx=(spot.srcCx*p.w-sx)/sw*cw, srcCy=(spot.srcCy*p.h-sy)/sh*ch;
    const rCpx=spot.r*p.w/sw*cw;
    const x0=Math.max(0,Math.floor(dstCx-rCpx)), x1=Math.min(cw-1,Math.ceil(dstCx+rCpx));
    const y0=Math.max(0,Math.floor(dstCy-rCpx)), y1=Math.min(ch-1,Math.ceil(dstCy+rCpx));
    if(x0>x1||y0>y1||rCpx<1) continue;
    const pw=x1-x0+1, ph=y1-y0+1;
    // snapshot source pixels before we overwrite anything
    const patch=new Uint8Array(pw*ph*4);
    for(let py=y0;py<=y1;py++) for(let px=x0;px<=x1;px++){
      const spx=Math.round(srcCx+(px-dstCx)), spy=Math.round(srcCy+(py-dstCy));
      const pi=((py-y0)*pw+(px-x0))*4;
      if(spx<0||spy<0||spx>=cw||spy>=ch){ patch[pi+3]=0; continue; }
      const si=(spy*cw+spx)*4;
      patch[pi]=data[si]; patch[pi+1]=data[si+1]; patch[pi+2]=data[si+2]; patch[pi+3]=255;
    }
    // blend into destination with feathered falloff: t = 1 - (d/r)²
    for(let py=y0;py<=y1;py++) for(let px=x0;px<=x1;px++){
      const d=Math.sqrt((px-dstCx)**2+(py-dstCy)**2);
      if(d>=rCpx) continue;
      const pi=((py-y0)*pw+(px-x0))*4;
      if(!patch[pi+3]) continue;
      const t=clamp(1-(d/rCpx)**2,0,1);
      const di=(py*cw+px)*4;
      data[di]  =Math.round(data[di]  +(patch[pi]  -data[di]  )*t);
      data[di+1]=Math.round(data[di+1]+(patch[pi+1]-data[di+1])*t);
      data[di+2]=Math.round(data[di+2]+(patch[pi+2]-data[di+2])*t);
    }
  }
}

/* ---------- render selected photo to #view (zoom/pan aware) ---------- */
const displayCanvas=$('#view'); const displayCtx=displayCanvas.getContext('2d');
const viewCanvas=document.createElement('canvas'); const vctx=viewCanvas.getContext('2d',{willReadFrequently:true});
const overlay=$('#overlay'); const octx=overlay.getContext('2d');
let renderTimer=null,renderPending=false;
let lastRegion=null; // {sx,sy,sw,sh,cw,ch} for overlay coordinate mapping

/* ---------- helpers for rotation/crop geometry ---------- */
function rotatedBounds(p){
  const rad=(p.adj.angle||0)*Math.PI/180;
  const cos=Math.abs(Math.cos(rad)), sin=Math.abs(Math.sin(rad));
  return {rad, rotW:p.w*cos+p.h*sin, rotH:p.w*sin+p.h*cos};
}
function hasCropTransform(p){
  if(!p) return false;
  if(p.adj.angle) return true;
  if(p.adj.flipH) return true;
  const c=p.adj.crop; return !!(c && (c.l||c.t||c.r!==1||c.b!==1));
}
// Draw bitmap to ctx with rotation+flipH+crop-offset applied. scale = pixels-per-image-pixel.
function _drawTransformed(ctx, p, cw, ch, scale, dx, dy){
  ctx.save();
  ctx.translate(cw/2, ch/2);
  if(p.adj.flipH) ctx.scale(-1, 1);
  ctx.rotate((p.adj.angle||0)*Math.PI/180);
  ctx.drawImage(p.bitmap, (-dx-p.w/2)*scale, (-dy-p.h/2)*scale, p.w*scale, p.h*scale);
  ctx.restore();
}

/* ---------- full-resolution render for export ---------- */
function renderFullRes(p){
  const hasCT = hasCropTransform(p);
  if(!hasCT){
    const c=document.createElement('canvas'); c.width=p.w; c.height=p.h;
    const x=c.getContext('2d',{willReadFrequently:true}); x.drawImage(p.bitmap,0,0);
    const img=x.getImageData(0,0,p.w,p.h);
    processImageData(img,p.adj); applyMasks(img,p,0,0,p.w,p.h); applySpots(img,p,0,0,p.w,p.h);
    x.putImageData(img,0,0);
    if(p.adj.distort||p.adj.vignette2) applyLensCorrections(c,p.adj);
    if(p.adj.vertPersp||p.adj.horizPersp) applyPerspective(c,p.adj);
    applyWatermark(c,state.watermark);
    return c;
  }
  const {rad,rotW,rotH}=rotatedBounds(p);
  const crop=p.adj.crop||{l:0,t:0,r:1,b:1};
  const cropW=(crop.r-crop.l)*rotW, cropH=(crop.b-crop.t)*rotH;
  const outW=Math.round(cropW), outH=Math.round(cropH);
  const dx=((crop.l+crop.r)/2-0.5)*rotW, dy=((crop.t+crop.b)/2-0.5)*rotH;
  const c=document.createElement('canvas'); c.width=outW; c.height=outH;
  const x=c.getContext('2d',{willReadFrequently:true});
  _drawTransformed(x,p,outW,outH,1,dx,dy);
  const img=x.getImageData(0,0,outW,outH);
  processImageData(img,p.adj);
  applyMasks(img,p,crop.l*rotW,crop.t*rotH,cropW,cropH);
  applySpots(img,p,crop.l*rotW,crop.t*rotH,cropW,cropH);
  x.putImageData(img,0,0);
  if(p.adj.distort||p.adj.vignette2) applyLensCorrections(c,p.adj);
  if(p.adj.vertPersp||p.adj.horizPersp) applyPerspective(c,p.adj);
  applyWatermark(c,state.watermark);
  return c;
}

/* ---------- viewport render with crop+angle (crop mode or applied transform) ---------- */
function renderStageTransform(p, availW, availH){
  const {rotW,rotH}=rotatedBounds(p);
  const crop=p.adj.crop||{l:0,t:0,r:1,b:1};
  let cw,ch,scale,dx=0,dy=0;

  if(state.cropMode){
    // Show full rotated image so user can see where to crop
    scale=Math.min(availW/rotW, availH/rotH);
    cw=Math.round(rotW*scale); ch=Math.round(rotH*scale);
    const dpr1=Math.min(window.devicePixelRatio||1,2);
    const dprF1=window.devicePixelRatio||1;
    const pcw1=Math.round(cw*dpr1), pch1=Math.round(ch*dpr1);
    const pcwF1=Math.round(cw*dprF1), pchF1=Math.round(ch*dprF1);
    viewCanvas.width=pcw1; viewCanvas.height=pch1;
    vctx.imageSmoothingEnabled=true; vctx.imageSmoothingQuality='high';
    vctx.scale(dpr1,dpr1);
    _drawTransformed(vctx,p,cw,ch,scale,0,0);
    vctx.setTransform(1,0,0,1,0,0);
    if(!state.showBefore){
      const img=vctx.getImageData(0,0,pcw1,pch1);
      processImageData(img,p.adj); vctx.putImageData(img,0,0);
      if(p.adj.distort||p.adj.vignette2) applyLensCorrections(viewCanvas,p.adj);
      if(p.adj.vertPersp||p.adj.horizPersp) applyPerspective(viewCanvas,p.adj);
    }
    displayCanvas.width=pcwF1; displayCanvas.height=pchF1;
    displayCanvas.style.width=cw+'px'; displayCanvas.style.height=ch+'px';
    displayCtx.imageSmoothingEnabled=true; displayCtx.imageSmoothingQuality='high';
    displayCtx.drawImage(viewCanvas,0,0,pcwF1,pchF1);
    state._cropView={scale,rotW,rotH,cw,ch};
    lastRegion={sx:0,sy:0,sw:rotW,sh:rotH,cw,ch};
  } else {
    // Normal view: show cropped region
    const cropW=(crop.r-crop.l)*rotW, cropH=(crop.b-crop.t)*rotH;
    scale=Math.min(availW/cropW, availH/cropH);
    cw=Math.round(cropW*scale); ch=Math.round(cropH*scale);
    dx=((crop.l+crop.r)/2-0.5)*rotW; dy=((crop.t+crop.b)/2-0.5)*rotH;
    const dpr2=Math.min(window.devicePixelRatio||1,2);
    const dprF2=window.devicePixelRatio||1;
    const pcw2=Math.round(cw*dpr2), pch2=Math.round(ch*dpr2);
    const pcwF2=Math.round(cw*dprF2), pchF2=Math.round(ch*dprF2);
    viewCanvas.width=pcw2; viewCanvas.height=pch2;
    vctx.imageSmoothingEnabled=true; vctx.imageSmoothingQuality='high';
    vctx.scale(dpr2,dpr2);
    _drawTransformed(vctx,p,cw,ch,scale,dx,dy);
    vctx.setTransform(1,0,0,1,0,0);
    if(!state.showBefore){
      const img=vctx.getImageData(0,0,pcw2,pch2);
      processImageData(img,p.adj);
      applyMasks(img,p,crop.l*rotW,crop.t*rotH,cropW*1,cropH*1);
      applySpots(img,p,crop.l*rotW,crop.t*rotH,cropW*1,cropH*1);
      vctx.putImageData(img,0,0);
      if(p.adj.distort||p.adj.vignette2) applyLensCorrections(viewCanvas,p.adj);
      if(p.adj.vertPersp||p.adj.horizPersp) applyPerspective(viewCanvas,p.adj);
    }
    displayCanvas.width=pcwF2; displayCanvas.height=pchF2;
    displayCanvas.style.width=cw+'px'; displayCanvas.style.height=ch+'px';
    displayCtx.imageSmoothingEnabled=true; displayCtx.imageSmoothingQuality='high';
    displayCtx.drawImage(viewCanvas,0,0,pcwF2,pchF2);
    lastRegion={sx:crop.l*rotW,sy:crop.t*rotH,sw:(crop.r-crop.l)*rotW,sh:(crop.b-crop.t)*rotH,cw,ch};
  }
  overlay.width=cw; overlay.height=ch; overlay.style.width=cw+'px'; overlay.style.height=ch+'px';
  drawOverlay(); drawHistogram(p);
  if(state.compareMode&&!state.showBefore) drawCompareSplit();
}

function renderStage(){
  const p=sel();
  if(!p){ displayCanvas.classList.add('hide'); overlay.classList.add('hide'); $('#empty').classList.remove('hide'); return; }
  $('#empty').classList.add('hide'); displayCanvas.classList.remove('hide');
  scheduleSessionSave();
  // Determine available render area
  let availW, availH;
  const mobEV=document.getElementById('mobEditView');
  const isMobEdit=window.innerWidth<=768&&mobEV&&mobEV.classList.contains('active');
  if(isMobEdit){
    // Calculate from window dimensions — avoids getBoundingClientRect timing issues
    const activePanel=document.querySelector('.mob-tool-panel.active');
    const panelH=activePanel?Math.min(activePanel.scrollHeight||0,Math.round(window.innerHeight*0.5)):0;
    availW=window.innerWidth;
    availH=Math.max(100,window.innerHeight-52-68-panelH); // 52=header, 68=toolbar
  } else {
    const box=stage.getBoundingClientRect();
    availW=Math.max(64,box.width-36);
    availH=Math.max(64,box.height-36);
    if(stage.classList.contains('sheet-open')){
      const rightCol=document.querySelector('.col.right');
      if(rightCol) availH=Math.max(64,availH-rightCol.getBoundingClientRect().height);
    } else if(stage.classList.contains('filmbar-open')){
      const fb=$('#filmbar');
      if(fb) availH=Math.max(64,availH-fb.getBoundingClientRect().height);
    }
  }
  if(state.cropMode||hasCropTransform(p)){ renderStageTransform(p,availW,availH); return; }
  let sx,sy,sw,sh,cw,ch;
  if(state.view.mode==='fit'){
    const scale=Math.min(availW/p.w, availH/p.h);
    cw=Math.round(p.w*scale); ch=Math.round(p.h*scale);
    sx=0; sy=0; sw=p.w; sh=p.h;
  } else {
    cw=Math.min(Math.round(availW), p.w); ch=Math.min(Math.round(availH), p.h);
    sw=cw; sh=ch;
    sx=clamp(state.view.panX, 0, p.w-sw); sy=clamp(state.view.panY, 0, p.h-sh);
    state.view.panX=sx; state.view.panY=sy;
  }
  const dprDev=window.devicePixelRatio||1;
  const dpr=state.view.mode==='fit' ? Math.min(dprDev,2) : 1;
  const pcw=Math.round(cw*dpr), pch=Math.round(ch*dpr);
  const pcwF=Math.round(cw*dprDev), pchF=Math.round(ch*dprDev);
  viewCanvas.width=pcw; viewCanvas.height=pch;
  vctx.imageSmoothingEnabled=true; vctx.imageSmoothingQuality='high';
  vctx.drawImage(p.bitmap,sx,sy,sw,sh,0,0,pcw,pch);

  const _gid=++_procGen;

  // Shared display update — called after processing (sync or async)
  function _display(){
    if(_procGen!==_gid)return;
    displayCanvas.width=pcwF; displayCanvas.height=pchF;
    displayCanvas.style.width=cw+'px'; displayCanvas.style.height=ch+'px';
    displayCtx.imageSmoothingEnabled=true; displayCtx.imageSmoothingQuality='high';
    displayCtx.drawImage(viewCanvas,0,0,pcwF,pchF);
    lastRegion={sx,sy,sw,sh,cw,ch};
    overlay.width=cw; overlay.height=ch; overlay.style.width=cw+'px'; overlay.style.height=ch+'px';
    drawOverlay(); drawHistogram(p);
    if(state.compareMode&&!state.showBefore) drawCompareSplit();
    // Mobile mirror
    const _mv=document.getElementById('mobEditView');
    if(window.innerWidth<=768&&_mv&&_mv.classList.contains('active')){
      const _mobV=document.getElementById('mobView');
      if(_mobV&&viewCanvas.width>0){
        const _ap=document.querySelector('.mob-tool-panel.active');
        const _ph=_ap?Math.min(_ap.scrollHeight||0,Math.round(window.innerHeight*0.5)):0;
        const _s=Math.min(window.innerWidth/p.w,Math.max(100,window.innerHeight-52-68-_ph)/p.h);
        const _cw=Math.round(p.w*_s),_ch=Math.round(p.h*_s);
        _mobV.width=_cw; _mobV.height=_ch;
        _mobV.style.width=_cw+'px'; _mobV.style.height=_ch+'px';
        _mobV.getContext('2d').drawImage(viewCanvas,0,0,_cw,_ch);
      }
    }
  }

  if(!state.showBefore){
    const img=vctx.getImageData(0,0,pcw,pch);

    // After processing: apply masks/spots/lens then display
    function _after(processed){
      if(_procGen!==_gid)return;
      applyMasks(processed,p,sx,sy,sw,sh);
      applySpots(processed,p,sx,sy,sw,sh);
      vctx.putImageData(processed,0,0);
      if(p.adj.distort||p.adj.vignette2) applyLensCorrections(viewCanvas,p.adj);
      if(p.adj.vertPersp||p.adj.horizPersp) applyPerspective(viewCanvas,p.adj);
      _display();
    }

    if(_procWorker){
      // ── Async path: transfer pixels to worker, never block main thread ──
      const xfer=img.data.buffer;
      _procWorker.onmessage=e=>{
        if(e.data.id===_gid)_after(new ImageData(new Uint8ClampedArray(e.data.buf),pcw,pch));
      };
      _procWorker.postMessage({buf:xfer,w:pcw,h:pch,adj:structuredClone(p.adj),id:_gid},[xfer]);
      return; // render happens in worker callback
    }
    // ── Sync fallback ──
    processImageData(img,p.adj);
    _after(img);
  } else {
    _display();
  }
}
function fitView(){ if(sel()) renderStage(); }
window.addEventListener('resize',()=>{ clearTimeout(renderTimer); renderTimer=setTimeout(fitView,80); });

/* ============================================================
   WEB WORKER — processImageData on background thread
   Build an inline blob worker from the pure pixel-processing functions.
   Falls back to synchronous processing if Worker creation fails.
   ============================================================ */
let _procWorker=null, _procGen=0;
try{
  _procWorker=new Worker('./worker.js');
  _procWorker.onerror=e=>{ console.warn('Worker error',e); _procWorker=null; };
}catch(e){ console.warn('Worker unavailable, using sync fallback'); }
function scheduleRender(delay=0){
  clearTimeout(renderTimer);
  if(delay>0){
    renderTimer=setTimeout(()=>{ renderPending=false; renderStage(); },delay);
    renderPending=true;
  } else {
    if(renderPending)return;
    renderPending=true;
    requestAnimationFrame(()=>{ renderPending=false; renderStage(); });
  }
}

/* ---------- histogram ---------- */
let histSrc=null, histSrcId=null;
function getHistSource(p){
  if(histSrcId===p.id && histSrc) return histSrc;
  const long=240, s=long/Math.max(p.w,p.h);
  const w=Math.max(8,Math.round(p.w*s)), h=Math.max(8,Math.round(p.h*s));
  const c=document.createElement('canvas'); c.width=w; c.height=h;
  c.getContext('2d',{willReadFrequently:true}).drawImage(p.bitmap,0,0,w,h);
  histSrc={canvas:c,w,h}; histSrcId=p.id; return histSrc;
}
function drawHistogram(p){
  const cv=$('#hist'); if(!cv)return;
  const W=cv.width,H=cv.height;
  const ctx=cv.getContext('2d');
  ctx.clearRect(0,0,W,H);
  if(!p||!p.bitmap){ctx.fillStyle='var(--panel-2)';ctx.fillRect(0,0,W,H);return;}
  const tmp=document.createElement('canvas');
  tmp.width=Math.min(p.w,256); tmp.height=Math.round(tmp.width*p.h/p.w);
  const tx=tmp.getContext('2d');
  tx.drawImage(p.bitmap,0,0,tmp.width,tmp.height);
  const id=tx.getImageData(0,0,tmp.width,tmp.height);
  const d=id.data,n=d.length/4;
  const lumH=new Float32Array(256),rH=new Float32Array(256),gH=new Float32Array(256),bH=new Float32Array(256);
  let clipS=0,clipH=0;
  for(let i=0;i<n;i++){
    const r=d[i*4],g=d[i*4+1],b=d[i*4+2];
    const lum=Math.round(0.299*r+0.587*g+0.114*b);
    lumH[lum]++; rH[r]++; gH[g]++; bH[b]++;
    if(lum<10) clipS++; if(lum>245) clipH++;
  }
  const peakL=Math.max(1,...lumH);
  const cs=getComputedStyle(document.documentElement);
  const bg=cs.getPropertyValue('--panel-2').trim()||'#23272f';
  const ln=cs.getPropertyValue('--line').trim()||'#2b303a';
  ctx.fillStyle=bg; ctx.fillRect(0,0,W,H);
  ctx.strokeStyle=ln; ctx.lineWidth=1; ctx.strokeRect(.5,.5,W-1,H-1);
  // luminance fill shape
  ctx.beginPath(); ctx.moveTo(0,H);
  for(let i=0;i<256;i++){
    const x=i/255*W, y=H-(lumH[i]/peakL)*(H-2)-1;
    i===0?ctx.moveTo(x,y):ctx.lineTo(x,y);
  }
  ctx.lineTo(W,H); ctx.closePath();
  ctx.fillStyle='rgba(180,185,195,.18)'; ctx.fill();
  // RGB channel curves
  const channels=[
    {h:rH,color:'rgba(220,70,70,.65)'},
    {h:gH,color:'rgba(70,200,120,.65)'},
    {h:bH,color:'rgba(70,130,230,.65)'}
  ];
  const peakCh=Math.max(1,...rH,...gH,...bH);
  channels.forEach(({h,color})=>{
    ctx.beginPath();
    for(let i=0;i<256;i++){
      const x=i/255*W,y=H-(h[i]/peakCh)*(H-2)-1;
      i===0?ctx.moveTo(x,y):ctx.lineTo(x,y);
    }
    ctx.strokeStyle=color; ctx.lineWidth=1.2; ctx.stroke();
  });
  // clipping indicators
  const clipEl=$('#clipS'),clipElH=$('#clipH');
  if(clipEl) clipEl.classList.toggle('on',clipS/n>.002);
  if(clipElH) clipElH.classList.toggle('on',clipH/n>.002);
}

/* ============================================================
   NAVIGATOR PANEL
   ============================================================ */
const navCanvas=$('#navCanvas');
const navCtx=navCanvas?navCanvas.getContext('2d'):null;
function updateNavigator(){
  if(!navCanvas||!navCtx)return;
  const p=sel();
  const W=navCanvas.clientWidth||200;
  navCanvas.width=W; navCanvas.height=Math.round(W*2/3);
  navCtx.clearRect(0,0,navCanvas.width,navCanvas.height);
  const info=$('#navInfo');
  if(!p){if(info)info.innerHTML='Select a photo to begin.';return;}
  // draw thumbnail
  navCtx.drawImage(p.bitmap,0,0,p.w,p.h,0,0,navCanvas.width,navCanvas.height);
  // draw zoom crop box if zoomed
  if(state.view.mode==='zoom'&&p){
    const r=state.view;
    const sx=r.panX/p.w*navCanvas.width,sy=r.panY/p.h*navCanvas.height;
    navCtx.strokeStyle='rgba(255,255,255,.8)';navCtx.lineWidth=1.5;
    navCtx.strokeRect(sx,sy,navCanvas.width-sx,navCanvas.height-sy);
  }
  // update info text
  if(info){
    const e=p.exif||{};
    const lines=[
      p.name,
      p.w&&p.h?`${p.w}×${p.h}`:'',
      e.fNumber?`f/${e.fNumber}`:'',
      e.exposureTime?`${e.exposureTime}s`:'',
      e.iso?`ISO ${e.iso}`:'',
    ].filter(Boolean);
    info.innerHTML=`<b>File</b>${lines[0]||''}<b>Size</b>${lines[1]||'—'}${e.fNumber||e.exposureTime||e.iso?`<b>Exposure</b>${[e.fNumber?'f/'+e.fNumber:'',e.exposureTime?e.exposureTime+'s':'',e.iso?'ISO '+e.iso:''].filter(Boolean).join(' ')}`:''} `;
  }
}
// Navigator toggle
const navToggleBtn=$('#navToggle');
const navPanel=$('#navPanel');
let navOpen=true;
if(navToggleBtn&&navPanel){
  navToggleBtn.addEventListener('click',()=>{
    navOpen=!navOpen;
    navPanel.classList.toggle('closed',!navOpen);
    navToggleBtn.textContent=navOpen?'‹':'›';
    setTimeout(()=>{ renderStage(); updateNavigator(); },200);
  });
}

/* ---- right panel collapse ---- */
(function(){
  const btn=$('#rPanelToggle');
  const col=document.querySelector('.col.right');
  if(!btn||!col)return;
  let open=true;
  btn.addEventListener('click',()=>{
    open=!open;
    col.classList.toggle('rp-closed',!open);
    document.querySelector('main').classList.toggle('rp-collapsed',!open);
    btn.textContent=open?'›':'‹';
    setTimeout(()=>renderStage(),220);
  });
})();

/* ---------- mask overlay drawing + interaction ---------- */
function n2c(nx,ny){ const r=lastRegion; return [ (nx*lastRegionImgW()-r.sx)/r.sw*r.cw, (ny*lastRegionImgH()-r.sy)/r.sh*r.ch ]; }
function lastRegionImgW(){ const p=sel(); return p?p.w:1; }
function lastRegionImgH(){ const p=sel(); return p?p.h:1; }
function c2n(cx,cy){ const r=lastRegion,p=sel(); return [ (r.sx+cx/r.cw*r.sw)/p.w, (r.sy+cy/r.ch*r.sh)/p.h ]; }
/* ---------- crop overlay (drawn when state.cropMode is true) ---------- */
function getCropHandles(crop, cw, ch){
  const x1=crop.l*cw, y1=crop.t*ch, x2=crop.r*cw, y2=crop.b*ch;
  const mx=(x1+x2)/2, my=(y1+y2)/2;
  return [
    {id:'tl',x:x1,y:y1},{id:'t',x:mx,y:y1},{id:'tr',x:x2,y:y1},
    {id:'ml',x:x1,y:my},                     {id:'mr',x:x2,y:my},
    {id:'bl',x:x1,y:y2},{id:'b',x:mx,y:y2},{id:'br',x:x2,y:y2}
  ];
}
function drawCropOverlay(){
  const p=sel(); if(!p||!state._cropView) return;
  const {cw,ch}=state._cropView;
  const crop=p.adj.crop||{l:0,t:0,r:1,b:1};
  const x1=crop.l*cw, y1=crop.t*ch, x2=crop.r*cw, y2=crop.b*ch;
  const w=x2-x1, h=y2-y1;
  // dim outside region
  octx.fillStyle='rgba(0,0,0,.55)';
  octx.fillRect(0,0,cw,y1); octx.fillRect(0,y2,cw,ch-y2);
  octx.fillRect(0,y1,x1,h); octx.fillRect(x2,y1,cw-x2,h);
  // rule-of-thirds grid
  octx.strokeStyle='rgba(255,255,255,.22)'; octx.lineWidth=1; octx.setLineDash([]);
  for(let i=1;i<3;i++){
    octx.beginPath(); octx.moveTo(x1+w*i/3,y1); octx.lineTo(x1+w*i/3,y2); octx.stroke();
    octx.beginPath(); octx.moveTo(x1,y1+h*i/3); octx.lineTo(x2,y1+h*i/3); octx.stroke();
  }
  // border
  octx.strokeStyle='rgba(255,255,255,.9)'; octx.lineWidth=1.5;
  octx.strokeRect(x1,y1,w,h);
  // corner brackets
  const bl=Math.min(22,w/4,h/4); octx.lineWidth=2.5; octx.strokeStyle='#fff';
  [[x1,y1,1,1],[x2,y1,-1,1],[x1,y2,1,-1],[x2,y2,-1,-1]].forEach(([cx,cy,dx,dy])=>{
    octx.beginPath(); octx.moveTo(cx+dx*bl,cy); octx.lineTo(cx,cy); octx.lineTo(cx,cy+dy*bl); octx.stroke();
  });
  // 8 resize handles — circles for better touch targeting
  getCropHandles(crop,cw,ch).forEach(h=>{
    octx.shadowColor='rgba(0,0,0,.55)'; octx.shadowBlur=5;
    octx.beginPath(); octx.arc(h.x,h.y,8,0,Math.PI*2);
    octx.fillStyle='#fff'; octx.fill();
    octx.shadowBlur=0;
    octx.strokeStyle='rgba(0,0,0,.2)'; octx.lineWidth=1;
    octx.beginPath(); octx.arc(h.x,h.y,8,0,Math.PI*2); octx.stroke();
  });
  octx.shadowBlur=0;
}

function drawSpotOverlay(){
  const p=sel(); if(!p||!lastRegion) return;
  const r=lastRegion;
  octx.save();
  for(const spot of (p.spots||[])){
    const dstCx=(spot.cx*p.w-r.sx)/r.sw*r.cw, dstCy=(spot.cy*p.h-r.sy)/r.sh*r.ch;
    const srcCx=(spot.srcCx*p.w-r.sx)/r.sw*r.cw, srcCy=(spot.srcCy*p.h-r.sy)/r.sh*r.ch;
    const rCpx=spot.r*p.w/r.sw*r.cw;
    const isSel=state.selSpot===spot.id;
    const col=isSel?'#E8A24A':'rgba(255,255,255,.85)';
    // connecting line
    octx.strokeStyle=isSel?'rgba(232,162,74,.55)':'rgba(255,255,255,.35)';
    octx.lineWidth=1; octx.setLineDash([4,4]); octx.shadowBlur=0;
    octx.beginPath(); octx.moveTo(dstCx,dstCy); octx.lineTo(srcCx,srcCy); octx.stroke();
    octx.setLineDash([]);
    // destination circle (solid)
    octx.strokeStyle=col; octx.lineWidth=isSel?2:1.5;
    octx.shadowColor='rgba(0,0,0,.55)'; octx.shadowBlur=4;
    octx.beginPath(); octx.arc(dstCx,dstCy,Math.max(2,rCpx),0,Math.PI*2); octx.stroke();
    // source circle (dashed)
    octx.setLineDash([5,4]);
    octx.beginPath(); octx.arc(srcCx,srcCy,Math.max(2,rCpx),0,Math.PI*2); octx.stroke();
    octx.setLineDash([]);
    octx.shadowBlur=0;
    // center dots
    dot2(dstCx,dstCy,isSel); dot2(srcCx,srcCy,isSel);
  }
  octx.restore();
}
function dot2(x,y,isSel){
  octx.fillStyle=isSel?'#E8A24A':'rgba(255,255,255,.9)';
  octx.beginPath(); octx.arc(x,y,3,0,Math.PI*2); octx.fill();
  octx.strokeStyle='rgba(0,0,0,.45)'; octx.lineWidth=1;
  octx.beginPath(); octx.arc(x,y,3,0,Math.PI*2); octx.stroke();
}

function drawOverlay(){
  octx.clearRect(0,0,overlay.width,overlay.height);
  const p=sel(); if(!p) return;
  if(state.cropMode){ drawCropOverlay(); return; }
  if(state.spotMode){ drawSpotOverlay(); return; }
  if(state.activeMask<0) return;
  const m=p.masks[state.activeMask]; if(!m)return;
  if(m.type==='brush'){
    // draw the brush mask buffer as a red overlay
    if(m._buf && m._bw && overlay.width>0){
      const r=lastRegion; if(!r)return;
      const tmp=document.createElement('canvas'); tmp.width=r.cw; tmp.height=r.ch;
      const tx=tmp.getContext('2d');
      const id=tx.createImageData(r.cw,r.ch);
      const d=id.data;
      for(let py=0;py<r.ch;py++){
        for(let px=0;px<r.cw;px++){
          const nx=(r.sx+px/r.cw*r.sw)/p.w, ny=(r.sy+py/r.ch*r.sh)/p.h;
          const bpx=clamp(Math.round(nx*m._bw),0,m._bw-1);
          const bpy=clamp(Math.round(ny*m._bh),0,m._bh-1);
          let w=m._buf[bpy*m._bw+bpx]; if(m.inverted)w=1-w;
          const i4=(py*r.cw+px)*4;
          d[i4]=230; d[i4+1]=60; d[i4+2]=90; d[i4+3]=Math.round(w*140);
        }
      }
      tx.putImageData(id,0,0);
      octx.drawImage(tmp,0,0);
    }
    return;
  }
  octx.strokeStyle='rgba(255,255,255,.9)'; octx.lineWidth=1.5;
  octx.shadowColor='rgba(0,0,0,.6)'; octx.shadowBlur=3;
  if(m.type==='radial'){
    const [cx,cy]=n2c(m.cx,m.cy);
    const rxp=m.rx*lastRegion.cw/lastRegion.sw*p.w, ryp=m.ry*lastRegion.ch/lastRegion.sh*p.h;
    octx.beginPath(); octx.ellipse(cx,cy,Math.max(2,rxp),Math.max(2,ryp),0,0,7); octx.stroke();
    dot(cx,cy); dot(cx+rxp,cy); dot(cx,cy+ryp);
  } else {
    const [x1,y1]=n2c(m.x1,m.y1), [x2,y2]=n2c(m.x2,m.y2);
    octx.beginPath(); octx.moveTo(x1,y1); octx.lineTo(x2,y2); octx.stroke();
    const ang=Math.atan2(y2-y1,x2-x1)+Math.PI/2, L=60;
    [[x1,y1],[x2,y2]].forEach(([px,py])=>{ octx.beginPath();
      octx.moveTo(px-Math.cos(ang)*L,py-Math.sin(ang)*L);
      octx.lineTo(px+Math.cos(ang)*L,py+Math.sin(ang)*L); octx.stroke(); });
    dot(x1,y1); dot(x2,y2);
  }
  octx.shadowBlur=0;
}
function dot(x,y){ octx.fillStyle='#fff'; octx.beginPath(); octx.arc(x,y,5,0,7); octx.fill();
  octx.strokeStyle='rgba(0,0,0,.5)'; octx.stroke(); octx.strokeStyle='rgba(255,255,255,.9)'; }

/* graduated/radial mask visual overlay helper */
function drawMaskOverlay(ctx, p, m, region){
  if(!m||!region)return;
  const {sx,sy,sw,sh,cw,ch}=region;
  function n2cL(nx,ny){ return [(nx*p.w-sx)/sw*cw, (ny*p.h-sy)/sh*ch]; }
  ctx.save();
  if(m.type==='radial'){
    const cx=m.cx??0.5, cy=m.cy??0.5, rx=m.rx??0.3, ry=m.ry??0.3;
    const [px,py]=n2cL(cx,cy);
    const prx=rx*p.w/sw*cw, pry=ry*p.h/sh*ch;
    ctx.beginPath(); ctx.ellipse(px,py,prx,pry,0,0,Math.PI*2);
    ctx.strokeStyle='rgba(255,255,255,.75)'; ctx.lineWidth=1.5; ctx.setLineDash([4,3]); ctx.stroke();
    ctx.setLineDash([]);
    ctx.beginPath(); ctx.arc(px,py,5,0,Math.PI*2);
    ctx.fillStyle='rgba(255,255,255,.9)'; ctx.fill();
    ctx.strokeStyle='rgba(0,0,0,.5)'; ctx.lineWidth=1; ctx.stroke();
  } else if(m.type==='linear'){
    // use y0/y1 if set (new style), else fall back to y1/y2 from the existing x1,y1,x2,y2 format
    const ya=m.y0??m.y1??0.3, yb=m.y1!==undefined&&m.y0!==undefined?m.y1:m.y2??0.7;
    const [,py0]=n2cL(0,ya), [,py1]=n2cL(0,yb);
    ctx.strokeStyle='rgba(255,255,255,.75)'; ctx.lineWidth=1.5; ctx.setLineDash([5,3]);
    ctx.beginPath(); ctx.moveTo(0,py0); ctx.lineTo(cw,py0); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(0,py1); ctx.lineTo(cw,py1); ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle='rgba(255,255,255,.06)';
    ctx.fillRect(0,Math.min(py0,py1),cw,Math.abs(py1-py0));
    [[cw/2,py0],[cw/2,py1]].forEach(([hx,hy])=>{
      ctx.beginPath(); ctx.arc(hx,hy,5,0,Math.PI*2);
      ctx.fillStyle='rgba(255,255,255,.9)'; ctx.fill();
      ctx.strokeStyle='rgba(0,0,0,.5)'; ctx.lineWidth=1; ctx.stroke();
    });
  }
  ctx.restore();
}

/* ============================================================
   AUTO-TONE — histogram stretch + gray-world white balance
   ============================================================ */
function autoTone(p){
  const long=200,s=long/Math.max(p.w,p.h);
  const w=Math.round(p.w*s),h=Math.round(p.h*s);
  const c=document.createElement('canvas');c.width=w;c.height=h;
  const x=c.getContext('2d',{willReadFrequently:true});x.drawImage(p.bitmap,0,0,w,h);
  const d=x.getImageData(0,0,w,h).data;
  let rs=0,gs=0,bs=0,lmin=255,lmax=0,n=0;
  for(let i=0;i<d.length;i+=4){
    rs+=d[i];gs+=d[i+1];bs+=d[i+2];n++;
    const l=0.299*d[i]+0.587*d[i+1]+0.114*d[i+2];
    if(l<lmin)lmin=l; if(l>lmax)lmax=l;
  }
  const ra=rs/n,ga=gs/n,ba=bs/n,gray=(ra+ga+ba)/3;
  const a=structuredClone(DEFAULT_ADJ);
  // white balance: nudge temp/tint to neutralise average
  a.temp=clamp(Math.round((ba-ra)/gray*70),-60,60);
  a.tint=clamp(Math.round((ga-(ra+ba)/2)/gray*60),-50,50);
  // exposure from mid lift
  const midTarget=128, midNow=(lmin+lmax)/2;
  a.exposure=clamp(+(Math.log2(midTarget/Math.max(midNow,1))).toFixed(2),-1,1);
  // contrast from spread
  const spread=lmax-lmin;
  a.contrast=clamp(Math.round((200-spread)/3),0,40);
  a.blacks=lmin>12?-Math.round((lmin-12)/3):0;
  a.whites=lmax<243?Math.round((243-lmax)/3):0;
  a.vibrance=12; a.clarity=8;
  return a;
}
$('#autoEdit').onclick=()=>{ const p=sel(); if(!p)return; pushHistory();
  p.adj=autoTone(p); syncSliders(); renderStage(); drawCurve(); renderLooks(); toast('Auto-toned'); };
$('#resetEdit').onclick=()=>{ const p=sel(); if(!p)return; pushHistory();
  p.adj=structuredClone(DEFAULT_ADJ); p.masks=[]; p.spots=[]; closeMaskEditor();
  if(state.cropMode) exitCropMode(false);
  syncSliders(); renderStage(); drawCurve(); renderMasks(); renderLooks(); };

/* ============================================================
   SLIDERS / VALUES
   ============================================================ */
$$('input[type=range][data-k]').forEach(inp=>{
  inp.addEventListener('input',()=>{
    const p=sel(); if(!p)return;
    const k=inp.dataset.k; p.adj[k]= k==='exposure'?parseFloat(inp.value):parseInt(inp.value);
    updateValLabel(k); setSliderFill(inp); scheduleRender(50);
  });
  setSliderFill(inp);
});
$$('.val[data-k]').forEach(v=>v.addEventListener('dblclick',()=>{
  const p=sel(); if(!p)return; const k=v.dataset.k;
  p.adj[k]=DEFAULT_ADJ[k]; syncSliders(); scheduleRender();
}));
function updateValLabel(k){
  const p=sel(); if(!p)return;
  const el=$(`.val[data-k="${k}"]`); if(!el)return;
  el.textContent = k==='exposure'?p.adj[k].toFixed(2):(p.adj[k]>0?'+':'')+p.adj[k];
}
function setSliderFill(el){
  const mn=parseFloat(el.min)||0,mx=parseFloat(el.max)||100,v=parseFloat(el.value)||0;
  el.style.setProperty('--fill',((v-mn)/(mx-mn)*100).toFixed(1)+'%');
}
function syncSliders(){
  const p=sel(); if(!p)return;
  $$('input[type=range][data-k]').forEach(inp=>{ if(p.adj[inp.dataset.k]!=null){inp.value=p.adj[inp.dataset.k]; setSliderFill(inp);} updateValLabel(inp.dataset.k); });
  syncHSLPanel();
  syncSplitTone();
  updateExifPanel();
  updateNavigator();
}

/* ============================================================
   ACCORDION EDIT SECTIONS
   ============================================================ */
function showEditSubtab(sec){
  const target=$(`.acc-section[data-sec="${sec}"]`);
  if(!target) return;
  target.classList.add('open');
  const panel=$('#editPanel');
  if(panel) panel.scrollTop=target.offsetTop-4;
}
$$('.acc-head').forEach(h=>{
  h.addEventListener('click',()=>{
    h.closest('.acc-section').classList.toggle('open');
  });
});

/* ============================================================
   TONE CURVE editor
   ============================================================ */
const curveCv=$('#curve'), cctx=curveCv.getContext('2d');
let dragPt=-1;
function curveToCanvas(pt){ return [pt[0]/255*curveCv.width, curveCv.height-pt[1]/255*curveCv.height]; }
function canvasToCurve(x,y){ return [clamp(Math.round(x/curveCv.width*255),0,255), clamp(Math.round((curveCv.height-y)/curveCv.height*255),0,255)]; }
function getCurvePoints(p){
  if(!p) return null;
  const ch=state.curveChannel;
  if(ch==='rgb') return p.adj.curve;
  if(!p.adj.rgbCurves) p.adj.rgbCurves=structuredClone(DEFAULT_ADJ.rgbCurves);
  return p.adj.rgbCurves[ch];
}
function drawCurve(){
  const p=sel(); const W=curveCv.width,H=curveCv.height;
  const cs=getComputedStyle(document.documentElement);
  const lineC=cs.getPropertyValue('--line').trim()||'#2b303a';
  const accent=cs.getPropertyValue('--amber').trim()||'#E8A24A';
  const inkC=cs.getPropertyValue('--ink').trim()||'#E7E9ED';
  const chColors={rgb:accent,r:'#e84058',g:'#50d48c',b:'#508ceb'};
  const curveColor=chColors[state.curveChannel]||accent;
  cctx.clearRect(0,0,W,H);
  cctx.strokeStyle=lineC; cctx.lineWidth=1;
  for(let i=1;i<4;i++){cctx.beginPath();cctx.moveTo(W*i/4,0);cctx.lineTo(W*i/4,H);cctx.moveTo(0,H*i/4);cctx.lineTo(W,H*i/4);cctx.stroke();}
  if(!p)return;
  const pts=[...getCurvePoints(p)].sort((a,b)=>a[0]-b[0]);
  cctx.strokeStyle=curveColor; cctx.lineWidth=2; cctx.beginPath();
  for(let x=0;x<=255;x+=3){
    let i=0;while(i<pts.length-1&&pts[i+1][0]<x)i++;
    const a=pts[i],b=pts[Math.min(i+1,pts.length-1)];
    const t=b[0]===a[0]?0:(x-a[0])/(b[0]-a[0]);
    const yv=a[1]+(b[1]-a[1])*t;
    const cx=x/255*W, cy=H-yv/255*H;
    x===0?cctx.moveTo(cx,cy):cctx.lineTo(cx,cy);
  }
  cctx.stroke();
  pts.forEach(pt=>{const[cx,cy]=curveToCanvas(pt);
    cctx.fillStyle=inkC;cctx.beginPath();cctx.arc(cx,cy,4,0,7);cctx.fill();});
}
curveCv.addEventListener('mousedown',e=>{
  const p=sel(); if(!p)return; const r=curveCv.getBoundingClientRect();
  const mx=e.clientX-r.left, my=e.clientY-r.top;
  const pts=getCurvePoints(p);
  for(let i=0;i<pts.length;i++){const[cx,cy]=curveToCanvas(pts[i]);
    if(Math.hypot(cx-mx,cy-my)<9){dragPt=i; beginGesture(); return;}}
});
curveCv.addEventListener('mousemove',e=>{
  if(dragPt<0)return; const p=sel(); if(!p)return;
  const r=curveCv.getBoundingClientRect();
  const nv=canvasToCurve(e.clientX-r.left,e.clientY-r.top);
  const pts=getCurvePoints(p);
  if(dragPt>0&&dragPt<pts.length-1) pts[dragPt]=nv;
  else pts[dragPt]=[pts[dragPt][0],nv[1]]; // endpoints fixed in x
  drawCurve(); scheduleRender();
});
window.addEventListener('mouseup',()=>{ dragPt=-1; endGesture(); });
curveCv.addEventListener('dblclick',e=>{
  const p=sel(); if(!p)return; const r=curveCv.getBoundingClientRect();
  const nv=canvasToCurve(e.clientX-r.left,e.clientY-r.top);
  const pts=getCurvePoints(p);
  for(let i=1;i<pts.length-1;i++){const[cx,cy]=curveToCanvas(pts[i]);
    if(Math.hypot(cx-(e.clientX-r.left),cy-(e.clientY-r.top))<10){pushHistory();pts.splice(i,1);drawCurve();scheduleRender();return;}}
  pushHistory(); pts.push(nv); drawCurve(); scheduleRender();
});

/* ============================================================
   PRESETS
   ============================================================ */
$('#savePreset').onclick=()=>{
  const p=sel(); if(!p){toast('Select a photo first');return;}
  const name=prompt('Preset name','Look '+(state.presets.length+1));
  if(!name)return;
  state.presets.push({name, adj:structuredClone(p.adj)});
  renderPresets(); toast('Preset saved');
};
function renderPresets(){
  const box=$('#presetList'); box.innerHTML='';
  if(!state.presets.length){ box.innerHTML='<div class="mini" style="padding:0">No presets yet. Tune a frame, then “Save current”.</div>'; return; }
  state.presets.forEach((pr,idx)=>{
    const el=document.createElement('div'); el.className='preset';
    el.innerHTML=`<span class="pn">${pr.name}</span>
      <button data-a="apply">Apply</button>
      <button data-a="all">All</button>
      <button data-a="del">✕</button>`;
    el.querySelector('[data-a=apply]').onclick=()=>{const p=sel();if(!p)return;
      pushHistory();p.adj=structuredClone(pr.adj);syncSliders();drawCurve();renderStage();renderLooks();toast('Applied “'+pr.name+'”');};
    el.querySelector('[data-a=all]').onclick=()=>{
      state.photos.forEach(p=>{p._undo.push(snapshot(p));p._redo.length=0;p.adj=structuredClone(pr.adj);});
      syncSliders();drawCurve();renderStage();updateUndoButtons();toast('“'+pr.name+'” applied to all '+state.photos.length);};
    el.querySelector('[data-a=del]').onclick=()=>{state.presets.splice(idx,1);renderPresets();};
    box.appendChild(el);
  });
}
$('#exportPresets').onclick=()=>{
  if(!state.presets.length){toast('No presets to export');return;}
  const blob=new Blob([JSON.stringify(state.presets,null,2)],{type:'application/json'});
  const a=document.createElement('a');a.href=URL.createObjectURL(blob);a.download='wildman-presets.json';a.click();
};
$('#importPresets').onclick=()=>$('#presetFile').click();
$('#presetFile').onchange=async e=>{
  const f=e.target.files[0]; if(!f)return;
  try{ const arr=JSON.parse(await f.text());
    if(Array.isArray(arr)){ state.presets.push(...arr.filter(x=>x.name&&x.adj)); renderPresets(); toast('Imported presets'); } }
  catch{ toast('Could not read that file'); }
};

/* ============================================================
   EXPORT (full-res, batched) — Electron: native folder dialog
                               Browser: download links
   ============================================================ */
$('#exportBtn').onclick=openExport;
function openExport(scope){
  // scope can come from native menu ('selected'|'picks'|'all') or button (show modal)
  if(scope && typeof scope==='string'){
    let list=[];
    if(scope==='selected'){ const p=sel(); if(p)list=[p]; }
    else list=state.photos.slice();
    if(!list.length){toast('Nothing to export');return;}
    exportList(list); return;
  }
  const cur=sel();
  $('#expSelectedSub').textContent=cur ? cur.name.replace(/\.[^.]+$/,'').substring(0,28) : 'no photo selected';
  $('#expAllSub').textContent=state.photos.length+' photo'+(state.photos.length!==1?'s':'');
  $('#exportModal').classList.remove('hide');
}
function closeExportModal(){ $('#exportModal').classList.add('hide'); }
$('#expCancel').onclick=closeExportModal;
$('#exportModal').onclick=e=>{ if(e.target===$('#exportModal')) closeExportModal(); };
$('#expSelected').onclick=()=>{
  closeExportModal();
  const p=sel(); if(p) exportList([p]); else toast('No photo selected');
};
$('#expAll').onclick=()=>{
  closeExportModal();
  if(state.photos.length) exportList(state.photos.slice()); else toast('No photos loaded');
};

async function exportList(list){
  busy(true,'Rendering '+list.length+' photo'+(list.length>1?'s':'')+'…');
  const mime = state.exportFormat==='png' ? 'image/png' : state.exportFormat==='webp' ? 'image/webp' : 'image/jpeg';
  const ext = state.exportFormat==='png' ? 'png' : state.exportFormat==='webp' ? 'webp' : 'jpg';
  // render all photos to base64 first
  const rendered=[];
  const usedNames=new Set();
  for(let i=0;i<list.length;i++){
    const p=list[i];
    busy(true,`Rendering ${i+1}/${list.length}: ${p.name}`);
    let c=renderFullRes(p);
    // Resize if enabled
    if(state.exportResize.enabled&&state.exportResize.longEdge>0){
      const le=state.exportResize.longEdge;
      const long=Math.max(c.width,c.height);
      if(long>le){
        const scale=le/long;
        const rc=document.createElement('canvas');
        rc.width=Math.round(c.width*scale);
        rc.height=Math.round(c.height*scale);
        rc.getContext('2d').drawImage(c,0,0,rc.width,rc.height);
        c=rc;
      }
    }
    const blob=await new Promise(res=>c.toBlob(res,mime,state.exportQuality));
    let outName=p.name.replace(/\.(jpe?g|png|webp|tiff?|nef|cr2|arw|dng|orf|rw2|pef|srw)$/i,'')+'_edited.'+ext;
    if(usedNames.has(outName)){
      // avoid silently overwriting when a RAW+JPEG pair share the same base filename
      const base=outName.replace(new RegExp(`\\.${ext}$`,'i'),''); let n=2;
      while(usedNames.has(`${base}_${n}.${ext}`)) n++;
      outName=`${base}_${n}.${ext}`;
    }
    usedNames.add(outName);
    if(IS_ELECTRON){
      const ab=await blob.arrayBuffer();
      const b64=btoa(String.fromCharCode(...new Uint8Array(ab)));
      rendered.push({name:outName, data:b64});
    } else {
      let _shared=false;
      if(window.innerWidth<=768&&navigator.canShare){
        const f=new File([blob],outName,{type:blob.type});
        if(navigator.canShare({files:[f]})){
          try{await navigator.share({files:[f],title:outName});_shared=true;}catch(e){}
        }
      }
      if(!_shared){
        const a=document.createElement('a');
        a.href=URL.createObjectURL(blob); a.download=outName; a.click();
        await wait(300);
      }
    }
    await wait(0);
  }
  if(IS_ELECTRON && rendered.length){
    busy(true,'Choosing export folder…');
    const result=await window.safelight.exportFiles(rendered);
    busy(false);
    if(result.canceled) toast('Export cancelled');
    else toast(`Exported ${result.saved} photo${result.saved!==1?'s':''} ✓`);
  } else {
    busy(false);
    toast('Exported '+list.length+' photo'+(list.length>1?'s':''));
  }
}

/* ============================================================
   THUMBNAILS + FILTERS + SELECTION
   ============================================================ */
// Long-press fires a DOM rebuild mid-gesture, so the gesture's own trailing
// click often never arrives to clear a one-shot suppress flag — use a time
// window instead so an unrelated later tap is never silently eaten.
let lastLongPressAt=0;
function renderThumbs(){
  const box=$('#thumbs'); box.innerHTML='';
  getSortedFilteredPhotos().forEach(p=>{
    const el=document.createElement('div');
    const isMultiSel=state.multiSel.has(p.id);
    el.className='thumb'+(p.id===state.selId&&!state.selectMode?' sel':'')+(isMultiSel?' sel':'');
    const ratingStars = p.rating ? '★'.repeat(p.rating) : '';
    const flagHtml = p.flag===1 ? '<span class="thumb-flag-pick"></span>' : p.flag===-1 ? '<span class="thumb-flag-reject"></span>' : '';
    el.innerHTML=`<span class="nm">${p.name}</span>`+
      (p.rating?`<span class="thumb-rating">${ratingStars}</span>`:'')+
      flagHtml+
      (state.selectMode?`<span class="checkmark${isMultiSel?' on':''}">${isMultiSel?'✓':''}</span>`:'');
    el.insertBefore(p.thumb,el.firstChild);
    el.onclick=()=>{
      if(Date.now()-lastLongPressAt<400) return;
      if(state.selectMode){
        if(state.multiSel.has(p.id)) state.multiSel.delete(p.id); else state.multiSel.add(p.id);
        updateSelectUI(); renderThumbs();
        return;
      }
      state.selId=p.id; onPhotoChanged(); renderThumbs(); renderStage(); syncSliders(); drawCurve(); renderLooks(); updateChrome(); mobTab('view');
    };
    el.addEventListener('contextmenu',e=>addToCollectionMenu(p,e));
    // long-press to enter select mode with this photo pre-selected
    let lpTimer=null;
    el.addEventListener('pointerdown',()=>{
      lpTimer=setTimeout(()=>{
        if(!state.selectMode){
          lastLongPressAt=Date.now();
          haptic([20,50,20]);
          state.selectMode=true; state.multiSel.add(p.id);
          updateSelectUI(); renderThumbs();
        }
      },480);
    });
    ['pointerup','pointerleave','pointercancel'].forEach(ev=>el.addEventListener(ev,()=>clearTimeout(lpTimer)));
    box.appendChild(el);
  });
  updateSelectUI();
}

function updateSelectUI(){
  const n=state.multiSel.size;
  $('#selectModeBtn').textContent = state.selectMode ? 'Cancel' : 'Select';
  $('#selAllBtn').classList.toggle('hide', !state.selectMode);
  $('#selExportBtn').classList.toggle('hide', !state.selectMode||n===0);
  $('#selDeleteBtn').classList.toggle('hide', !state.selectMode||n===0);
  $('#filmCount').textContent = state.selectMode
    ? n+' selected'
    : state.photos.length+' photo'+(state.photos.length!==1?'s':'');
}

$('#selectModeBtn').onclick=()=>{
  state.selectMode=!state.selectMode;
  if(!state.selectMode) state.multiSel.clear();
  updateSelectUI(); renderThumbs();
};
$('#selAllBtn').onclick=()=>{
  if(state.multiSel.size===state.photos.length) state.multiSel.clear();
  else state.photos.forEach(p=>state.multiSel.add(p.id));
  updateSelectUI(); renderThumbs();
};
$('#selExportBtn').onclick=()=>{
  const list=state.photos.filter(p=>state.multiSel.has(p.id));
  if(!list.length){ toast('No photos selected'); return; }
  exportList(list);
};
$('#selDeleteBtn').onclick=()=>{
  const ids=[...state.multiSel];
  if(!ids.length){ toast('No photos selected'); return; }
  if(!confirm(`Delete ${ids.length} photo${ids.length>1?'s':''}? This can't be undone.`)) return;
  state.selectMode=false;
  deletePhotos(ids);
  updateSelectUI();
};
$('#deleteBtn').onclick=()=>{
  const p=sel(); if(!p) return;
  if(!confirm(`Delete "${p.name}"? This can't be undone.`)) return;
  deletePhotos([p.id]);
};

/* ---------- nav ---------- */
function move(dir){
  const photos=state.photos; if(!photos.length)return;
  let i=photos.findIndex(p=>p.id===state.selId);
  i=clamp(i+dir,0,photos.length-1); state.selId=photos[i].id; haptic(6); onPhotoChanged();
  renderThumbs(); renderStage(); syncSliders(); drawCurve(); renderLooks(); updateChrome();
}
$('#prev').onclick=()=>move(-1); $('#next').onclick=()=>move(1);

const beforeBtn=$('#beforeBtn');
function before(on){ state.showBefore=on; beforeBtn.classList.toggle('active',on); renderStage(); }
beforeBtn.addEventListener('mousedown',()=>before(true));
window.addEventListener('mouseup',()=>{ if(state.showBefore)before(false); });

/* ---------- keyboard ---------- */
window.addEventListener('keydown',e=>{
  if(e.target.tagName==='INPUT'&&e.target.type!=='range')return;
  if((e.ctrlKey||e.metaKey)&&(e.key==='z'||e.key==='Z')&&!e.shiftKey){undo();e.preventDefault();return;}
  if((e.ctrlKey||e.metaKey)&&((e.key==='y'||e.key==='Y')||((e.key==='z'||e.key==='Z')&&e.shiftKey))){redo();e.preventDefault();return;}
  if(e.key==='ArrowRight'){move(1);e.preventDefault();}
  else if(e.key==='ArrowLeft'){move(-1);e.preventDefault();}
  else if(e.key==='b'||e.key==='B'){if(!state.showBefore)before(true);}
  else if(e.key==='a'||e.key==='A'){$('#autoEdit').click();}
  else if(e.key==='z'||e.key==='Z'){if(sel())toggleZoom();}
  else if(e.key==='p'||e.key==='P'){setFlag(1);}
  else if(e.key==='x'||e.key==='X'){setFlag(-1);}
  else if(e.key==='u'||e.key==='U'){setFlag(0);}
  else if(e.key>='1'&&e.key<='5'&&!e.ctrlKey&&!e.metaKey){setRating(parseInt(e.key));}
  else if(e.key==='0'&&!e.ctrlKey&&!e.metaKey){setRating(0);}
  else if(e.key==='f'||e.key==='F'){toggleFullscreen();}
  else if(e.key==='c'||e.key==='C'){toggleCompareMode();}
  else if((e.key==='Delete'||e.key==='Backspace')&&state.spotMode&&state.selSpot!=null){
    const p=sel(); if(p){ pushHistory(); p.spots=p.spots.filter(s=>s.id!==state.selSpot);
      state.selSpot=null; renderStage(); drawOverlay(); } e.preventDefault(); }
});
window.addEventListener('keyup',e=>{ if((e.key==='b'||e.key==='B')&&state.showBefore)before(false); });

/* ============================================================
   CHROME
   ============================================================ */
function updateChrome(){
  const n=state.photos.length;
  $('#count').textContent = n? n+' photo'+(n>1?'s':'') : 'no photos';
  $('#exportBtn').disabled=!n;
  const p=sel();
  $('#nav').textContent = p? (state.photos.findIndex(x=>x.id===p.id)+1)+' / '+n : '';
}

/* ============================================================
   BUILT-IN LOOKS + THEME
   ============================================================ */
function lookPreset(partial){ return Object.assign(structuredClone(DEFAULT_ADJ), structuredClone(partial)); }
const BUILTIN_PRESETS=[
  {cat:'Essentials', name:'Original',      adj:lookPreset({})},

  {cat:'Mono', name:'Mono Classic', adj:lookPreset({saturation:-100,contrast:18,clarity:20})},
  {cat:'Mono', name:'Mono Bold',    adj:lookPreset({saturation:-100,contrast:42,blacks:-20,whites:15,clarity:28})},
  {cat:'Mono', name:'Mono Soft',    adj:lookPreset({saturation:-100,contrast:-10,highlights:-10,shadows:10,clarity:5})},
  {cat:'Mono', name:'Mono Cool',    adj:lookPreset({saturation:-100,temp:-20,contrast:22,clarity:15})},
  {cat:'Mono', name:'Mono Warm',    adj:lookPreset({saturation:-100,temp:25,contrast:20,clarity:12})},
  {cat:'Mono', name:'Mono High-Key',adj:lookPreset({saturation:-100,exposure:0.25,contrast:-8,whites:20})},

  {cat:'Film', name:'Soft Film',    adj:lookPreset({contrast:-12,temp:12,vibrance:8,saturation:-8,curve:[[0,18],[64,72],[192,196],[255,238]]})},
  {cat:'Film', name:'Fade Matte',   adj:lookPreset({contrast:-18,vibrance:-6,curve:[[0,36],[128,128],[255,226]]})},
  {cat:'Film', name:'Vintage Warm', adj:lookPreset({temp:22,tint:8,contrast:-10,vibrance:-10,curve:[[0,22],[128,132],[255,235]]})},
  {cat:'Film', name:'Faded Slide',  adj:lookPreset({contrast:-15,vibrance:-15,whites:-10,blacks:10,curve:[[0,28],[128,126],[255,230]]})},
  {cat:'Film', name:'Cross Process',adj:lookPreset({temp:-10,tint:15,contrast:20,curve:[[0,10],[96,80],[160,180],[255,245]]})},
  {cat:'Film', name:'Bleach Bypass',adj:lookPreset({saturation:-40,contrast:35,clarity:25})},

  {cat:'Color & Punch', name:'Punch',        adj:lookPreset({contrast:28,vibrance:30,clarity:18,saturation:6})},
  {cat:'Color & Punch', name:'Vivid Nature', adj:lookPreset({vibrance:35,saturation:10,contrast:15,clarity:10})},
  {cat:'Color & Punch', name:'Teal/Orange',  adj:lookPreset({temp:14,vibrance:18,contrast:14,curve:[[0,10],[64,56],[192,202],[255,250]]})},
  {cat:'Color & Punch', name:'Autumn Glow',  adj:lookPreset({temp:20,vibrance:25,contrast:12,highlights:-10})},
  {cat:'Color & Punch', name:'Forest Boost', adj:lookPreset({vibrance:20,saturation:8,temp:-5,clarity:15})},
  {cat:'Color & Punch', name:'Sky Pop',      adj:lookPreset({contrast:18,vibrance:22,temp:-8,clarity:10})},

  {cat:'Light & Mood', name:'High Key',      adj:lookPreset({exposure:0.32,shadows:30,whites:18,contrast:-6})},
  {cat:'Light & Mood', name:'Moody',         adj:lookPreset({exposure:-0.18,contrast:24,shadows:-22,highlights:-10,vibrance:-8,clarity:14})},
  {cat:'Light & Mood', name:'Golden Hour',   adj:lookPreset({temp:30,tint:5,exposure:0.1,highlights:-15,vibrance:10})},
  {cat:'Light & Mood', name:'Misty Morning', adj:lookPreset({contrast:-12,whites:-15,shadows:15,vibrance:-10,exposure:0.05})},
  {cat:'Light & Mood', name:'Overcast Lift', adj:lookPreset({exposure:0.15,shadows:20,contrast:-5,vibrance:8})},
  {cat:'Light & Mood', name:'Deep Shadow',   adj:lookPreset({exposure:-0.2,blacks:-25,contrast:20,clarity:12})},

  {cat:'Portrait', name:'Portrait',  adj:lookPreset({contrast:10,clarity:14,temp:8,vibrance:14,sharpen:25})},
  {cat:'Portrait', name:'Warm Skin', adj:lookPreset({temp:12,vibrance:10,highlights:-8,clarity:8})},
  {cat:'Portrait', name:'Soft Glow', adj:lookPreset({contrast:-8,clarity:-15,highlights:-5,exposure:0.05})},

  // Cinematic
  {cat:'Cinematic', name:'Teal & Orange',  adj:lookPreset({temp:18,contrast:22,vibrance:15,splitTone:{shadowHue:195,shadowSat:35,highlightHue:28,highlightSat:40,balance:10}})},
  {cat:'Cinematic', name:'Hollywood Gold', adj:lookPreset({temp:24,contrast:18,highlights:-12,shadows:8,vibrance:12,splitTone:{shadowHue:200,shadowSat:20,highlightHue:42,highlightSat:50,balance:20}})},
  {cat:'Cinematic', name:'Noir',           adj:lookPreset({saturation:-85,contrast:45,blacks:-30,whites:10,clarity:30,curve:[[0,0],[64,40],[192,210],[255,255]]})},
  {cat:'Cinematic', name:'Bleach & Cyan',  adj:lookPreset({saturation:-30,contrast:30,clarity:20,splitTone:{shadowHue:192,shadowSat:30,highlightHue:0,highlightSat:0,balance:-20}})},
  {cat:'Cinematic', name:'Indie Matte',    adj:lookPreset({contrast:-8,vibrance:-8,curve:[[0,22],[96,88],[160,172],[255,238]],splitTone:{shadowHue:220,shadowSat:20,highlightHue:40,highlightSat:15,balance:0}})},
  {cat:'Cinematic', name:'Twilight',       adj:lookPreset({temp:-18,contrast:28,shadows:-15,vibrance:10,splitTone:{shadowHue:240,shadowSat:30,highlightHue:30,highlightSat:20,balance:-10}})},
  {cat:'Cinematic', name:'Summer Haze',    adj:lookPreset({temp:15,contrast:-5,highlights:-20,vibrance:18,curve:[[0,14],[128,132],[255,242]]})},
  {cat:'Cinematic', name:'Cold City',      adj:lookPreset({temp:-22,contrast:25,clarity:15,vibrance:8,splitTone:{shadowHue:210,shadowSat:35,highlightHue:180,highlightSat:10,balance:0}})},

  // Landscape
  {cat:'Landscape', name:'Deep Forest',    adj:lookPreset({temp:-8,contrast:18,clarity:20,vibrance:28,highlights:-15,shadows:10})},
  {cat:'Landscape', name:'Desert Sun',     adj:lookPreset({temp:30,tint:8,contrast:20,highlights:-10,whites:-8,vibrance:15,clarity:12})},
  {cat:'Landscape', name:'Coastal Fog',    adj:lookPreset({temp:-10,contrast:-8,whites:-12,shadows:18,vibrance:10,clarity:-5})},
  {cat:'Landscape', name:'Mountain Blue',  adj:lookPreset({temp:-15,contrast:22,clarity:18,vibrance:20,highlights:-8})},
  {cat:'Landscape', name:'Golden Fields',  adj:lookPreset({temp:26,tint:5,exposure:0.1,highlights:-14,vibrance:22,saturation:8})},
  {cat:'Landscape', name:'Storm Drama',    adj:lookPreset({contrast:35,blacks:-25,highlights:-20,clarity:28,vibrance:8,saturation:-10})},
  {cat:'Landscape', name:'Autumn',         adj:lookPreset({temp:22,tint:10,contrast:16,vibrance:30,saturation:12,shadows:8})},
  {cat:'Landscape', name:'Winter White',   adj:lookPreset({temp:-8,contrast:-5,whites:22,highlights:-18,vibrance:5,clarity:8})},

  // Nature
  {cat:'Nature', name:'Wildlife Sharp',    adj:lookPreset({contrast:20,clarity:22,sharpen:40,vibrance:12,highlights:-8})},
  {cat:'Nature', name:'Bird Sky',          adj:lookPreset({temp:-8,contrast:18,clarity:15,vibrance:16,highlights:-12,saturation:8})},
  {cat:'Nature', name:'Macro Soft',        adj:lookPreset({contrast:8,clarity:-5,sharpen:20,vibrance:20,highlights:-8,exposure:0.1})},
  {cat:'Nature', name:'Green & Lush',      adj:lookPreset({temp:-5,contrast:15,vibrance:35,saturation:15,clarity:12})},
  {cat:'Nature', name:'Night Sky',         adj:lookPreset({exposure:-0.1,contrast:30,blacks:-35,highlights:-20,clarity:20,denoiseL:40,denoiseC:30})},
  {cat:'Nature', name:'Sunrise Glow',      adj:lookPreset({temp:32,tint:8,exposure:0.08,highlights:-18,shadows:12,vibrance:20})},

  // Film Simulations
  {cat:'Film', name:'Kodak Gold',         adj:lookPreset({temp:20,tint:6,contrast:8,vibrance:15,saturation:5,curve:[[0,12],[96,105],[192,195],[255,240]]})},
  {cat:'Film', name:'Fuji Velvia',        adj:lookPreset({contrast:30,vibrance:40,saturation:20,clarity:10,curve:[[0,5],[96,88],[192,205],[255,250]]})},
  {cat:'Film', name:'Agfa Portrait',      adj:lookPreset({temp:14,contrast:-5,vibrance:12,saturation:-5,highlights:-8,curve:[[0,18],[128,130],[255,232]]})},
  {cat:'Film', name:'Ilford HP5',         adj:lookPreset({saturation:-100,contrast:22,clarity:18,curve:[[0,10],[64,55],[192,200],[255,248]]})},
  {cat:'Film', name:'Kodachrome',         adj:lookPreset({temp:12,contrast:25,vibrance:20,saturation:15,whites:8,curve:[[0,8],[96,90],[160,176],[255,248]]})},

  // Portrait extended
  {cat:'Portrait', name:'Clean Editorial', adj:lookPreset({contrast:12,clarity:8,sharpen:20,vibrance:8,temp:5})},
  {cat:'Portrait', name:'Moody Dark',      adj:lookPreset({exposure:-0.15,contrast:22,shadows:-20,highlights:-12,vibrance:-5,clarity:10})},
  {cat:'Portrait', name:'Ethereal',        adj:lookPreset({exposure:0.12,contrast:-10,clarity:-20,highlights:-5,vibrance:8,saturation:-5})},
  {cat:'Portrait', name:'Studio Pop',      adj:lookPreset({contrast:18,vibrance:22,clarity:15,sharpen:15,saturation:8})},

  // Mono extended
  {cat:'Mono', name:'Silver Gelatin',     adj:lookPreset({saturation:-100,contrast:28,clarity:22,curve:[[0,8],[64,58],[192,205],[255,252]]})},
  {cat:'Mono', name:'Faded Silver',       adj:lookPreset({saturation:-100,contrast:-5,whites:-8,blacks:10,curve:[[0,28],[128,124],[255,228]]})},
  {cat:'Mono', name:'Infrared',           adj:lookPreset({saturation:-100,contrast:40,clarity:30,whites:20,blacks:-30,curve:[[0,0],[64,100],[192,220],[255,255]]})},
  {cat:'Mono', name:'Selenium',           adj:lookPreset({saturation:-100,contrast:24,temp:8,clarity:16,curve:[[0,6],[96,90],[192,198],[255,248]]})},
];

function lookSource(p){
  if(p._lookSrc) return p._lookSrc;
  const dpr=Math.min(window.devicePixelRatio||1,3);
  const long=130*dpr, s=long/Math.max(p.w,p.h);
  const w=Math.max(8,Math.round(p.w*s)), h=Math.max(8,Math.round(p.h*s));
  const c=document.createElement('canvas'); c.width=w; c.height=h;
  const x=c.getContext('2d',{willReadFrequently:true});
  x.imageSmoothingEnabled=true; x.imageSmoothingQuality='high';
  x.drawImage(p.bitmap,0,0,w,h);
  p._lookSrc={canvas:c,w,h}; return p._lookSrc;
}
function renderLooks(){
  const container=$('#lookGrid'); if(!container)return; container.innerHTML='';
  const p=sel();
  const cats=[...new Set(BUILTIN_PRESETS.map(l=>l.cat))];
  cats.forEach(cat=>{
    const head=document.createElement('div'); head.className='look-cat-h'; head.textContent=cat;
    container.appendChild(head);
    const grid=document.createElement('div'); grid.className='looks';
    BUILTIN_PRESETS.filter(l=>l.cat===cat).forEach(lk=>{
      const tile=document.createElement('div'); tile.className='look';
      if(p && JSON.stringify(p.adj)===JSON.stringify(lk.adj)) tile.classList.add('on');
      if(p){
        const src=lookSource(p);
        const cv=document.createElement('canvas'); cv.width=src.w; cv.height=src.h;
        const x=cv.getContext('2d',{willReadFrequently:true});
        x.drawImage(src.canvas,0,0);
        const img=x.getImageData(0,0,src.w,src.h);
        processImageData(img,lk.adj); x.putImageData(img,0,0);
        tile.appendChild(cv);
      } else {
        const ni=document.createElement('div'); ni.className='noimg'; ni.textContent='—'; tile.appendChild(ni);
      }
      const ln=document.createElement('div'); ln.className='ln'; ln.textContent=lk.name; tile.appendChild(ln);
      tile.onclick=()=>{ const q=sel(); if(!q){toast('Select a photo first');return;}
        pushHistory(); q.adj=structuredClone(lk.adj); syncSliders(); drawCurve(); renderStage(); renderLooks(); toast(lk.name); };
      grid.appendChild(tile);
    });
    container.appendChild(grid);
  });
}

function setTheme(v){
  document.documentElement.dataset.theme=v;
  $$('#themeGrid .subtab').forEach(b=>b.classList.toggle('on', b.dataset.theme===v));
  drawCurve(); renderLooks();
  if(IS_ELECTRON) window.safelight.setPrefs({theme:v});
}
$$('#themeGrid .subtab').forEach(b=>b.onclick=()=>setTheme(b.dataset.theme));

/* ============================================================
   SETTINGS MODAL
   ============================================================ */
$('#settingsBtn').onclick=()=>$('#settingsModal').classList.remove('hide');
$('#settingsCloseBtn').onclick=()=>$('#settingsModal').classList.add('hide');
$('#settingsModal').onclick=e=>{ if(e.target===$('#settingsModal')) $('#settingsModal').classList.add('hide'); };
$('#clearAllBtn').onclick=()=>{
  if(!state.photos.length){ toast('No photos to clear'); $('#settingsModal').classList.add('hide'); return; }
  if(!confirm(`Delete all ${state.photos.length} photo${state.photos.length>1?'s':''} from this device? This can't be undone.`)) return;
  deletePhotos(state.photos.map(p=>p.id));
  $('#settingsModal').classList.add('hide');
};

/* ---- export format & quality (shared by the export modal) ---- */
function updateExportFmtUI(){
  $$('#exportFmtRow .subtab').forEach(b=>b.classList.toggle('on', b.dataset.fmt===state.exportFormat));
  $('#exportQualityRow').classList.toggle('hide', state.exportFormat==='png');
}
$$('#exportFmtRow .subtab').forEach(b=>b.onclick=()=>{ state.exportFormat=b.dataset.fmt; updateExportFmtUI(); });
$('#exportQuality').oninput=e=>{ state.exportQuality=+e.target.value/100; $('#exportQualityVal').textContent=e.target.value; };
updateExportFmtUI();

$('#updateReloadBtn').onclick=()=>location.reload();
$('#updateDismissBtn').onclick=()=>$('#updateBanner').classList.remove('show');

/* ============================================================
   UNDO / REDO
   ============================================================ */
let gestureSnap=null;
function snapshot(p){ return {adj:structuredClone(p.adj), masks:structuredClone(p.masks), spots:structuredClone(p.spots||[])}; }
function commitSnapshot(snap){ const p=sel(); if(!p||!snap)return;
  p._undo.push(snap); if(p._undo.length>50)p._undo.shift(); p._redo.length=0; updateUndoButtons(); }
function pushHistory(){ const p=sel(); if(p) commitSnapshot(snapshot(p)); }   // call BEFORE mutating
function beginGesture(){ const p=sel(); if(p&&!gestureSnap) gestureSnap=snapshot(p); }
function endGesture(){ if(gestureSnap){ commitSnapshot(gestureSnap); gestureSnap=null; } }
function restore(p,snap){ p.adj=structuredClone(snap.adj); p.masks=structuredClone(snap.masks); p.spots=structuredClone(snap.spots||[]); }
function afterEditChange(){ syncSliders(); drawCurve(); renderMasks();
  if(state.activeMask>=sel()?.masks.length) state.activeMask=-1;
  if(state.activeMask>=0) syncMaskSliders(); else closeMaskEditor();
  renderStage(); renderLooks(); updateUndoButtons(); }
function undo(){ const p=sel(); if(!p||!p._undo.length)return;
  p._redo.push(snapshot(p)); restore(p,p._undo.pop()); afterEditChange(); }
function redo(){ const p=sel(); if(!p||!p._redo.length)return;
  p._undo.push(snapshot(p)); restore(p,p._redo.pop()); afterEditChange(); }
function updateUndoButtons(){ const p=sel();
  $('#undoBtn').disabled=!(p&&p._undo.length); $('#redoBtn').disabled=!(p&&p._redo.length); }
$('#undoBtn').onclick=undo; $('#redoBtn').onclick=redo;
// snapshot global + mask sliders as one gesture
$$('#editPanel input[type=range]').forEach(inp=>{
  inp.addEventListener('pointerdown',beginGesture);
  inp.addEventListener('change',endGesture);
});

/* ============================================================
   ZOOM + PAN
   ============================================================ */
function updateZoomBtn(){ $('#zoomBtn').textContent = state.view.mode==='fit'?'100%':'Fit';
  stage.classList.toggle('zoomed',state.view.mode!=='fit'); }
function toggleZoom(nx,ny){
  const p=sel(); if(!p)return;
  if(hasCropTransform(p)||state.cropMode) return; // zoom disabled when crop/angle is set
  if(state.view.mode==='fit'){
    state.view.mode='100';
    const box=stage.getBoundingClientRect();
    const cw=Math.min(box.width-36,p.w), ch=Math.min(box.height-36,p.h);
    const fx=(nx==null?0.5:nx), fy=(ny==null?0.5:ny);
    state.view.panX=clamp(fx*p.w-cw/2,0,p.w-cw);
    state.view.panY=clamp(fy*p.h-ch/2,0,p.h-ch);
  } else state.view.mode='fit';
  updateZoomBtn(); renderStage();
}
$('#zoomBtn').onclick=()=>toggleZoom();
// click image to toggle zoom (only when not editing a mask)
stage.addEventListener('click',e=>{
  if(e.target!==stage) return; // only the empty background, not the canvas (handled below) or controls
  if(window.innerWidth<=768){
    const leftOpen=$('#filmbar')&&$('#filmbar').classList.contains('mob-show');
    const rightOpen=document.querySelector('.col.right')&&document.querySelector('.col.right').classList.contains('mob-show');
    if(leftOpen||rightOpen) mobTab('view');
  }
});
displayCanvas.addEventListener('click',e=>{
  // tapping the photo while a mobile panel is open closes it and returns full focus to the image
  if(window.innerWidth<=768){
    const leftOpen=$('#filmbar')&&$('#filmbar').classList.contains('mob-show');
    const rightOpen=document.querySelector('.col.right')&&document.querySelector('.col.right').classList.contains('mob-show');
    if(leftOpen||rightOpen){ mobTab('view'); return; }
  }
  if(overlay.classList.contains('live'))return;
  if(panMoved){panMoved=false;return;}
  const r=lastRegion,p=sel(); if(!r||!p)return;
  const nx=(r.sx+e.offsetX/r.cw*r.sw)/p.w, ny=(r.sy+e.offsetY/r.ch*r.sh)/p.h;
  toggleZoom(nx,ny);
});
// pan by dragging when zoomed
let panning=false, panStart=null, panMoved=false;
displayCanvas.addEventListener('pointerdown',e=>{
  if(state.view.mode==='fit'||overlay.classList.contains('live'))return;
  panning=true; panMoved=false; panStart={x:e.clientX,y:e.clientY,px:state.view.panX,py:state.view.panY};
  stage.classList.add('panning'); displayCanvas.setPointerCapture(e.pointerId);
});
displayCanvas.addEventListener('pointermove',e=>{
  if(!panning)return; const p=sel(); const r=lastRegion;
  const dx=(e.clientX-panStart.x)*(r.sw/r.cw), dy=(e.clientY-panStart.y)*(r.sh/r.ch);
  if(Math.abs(dx)>2||Math.abs(dy)>2)panMoved=true;
  state.view.panX=clamp(panStart.px-dx,0,p.w-r.sw); state.view.panY=clamp(panStart.py-dy,0,p.h-r.sh);
  renderStage();
});
displayCanvas.addEventListener('pointerup',()=>{ panning=false; stage.classList.remove('panning'); });

/* ============================================================
   MASKS
   ============================================================ */

/* --- brush buffer helpers --- */
const BRUSH_RES = 0.5; // fraction of original image resolution for the buffer
function getBrushBuf(p){
  const m=p.masks[state.activeMask]; if(!m||m.type!=='brush')return null;
  if(!m._buf){
    m._bw=Math.max(8,Math.round(p.w*BRUSH_RES));
    m._bh=Math.max(8,Math.round(p.h*BRUSH_RES));
    m._buf=new Float32Array(m._bw*m._bh);
  }
  return m;
}

/* paint one dab into the brush buffer */
function paintDab(m, nx, ny, erasing){
  const bx=Math.round(nx*m._bw), by=Math.round(ny*m._bh);
  const b=state.brush;
  // radius in buffer pixels
  const radX=Math.max(1,(b.size/2)*m._bw/640);
  const radY=Math.max(1,(b.size/2)*m._bh/480);
  const rad=Math.sqrt(radX*radY);
  const hard=b.hardness/100, flow=b.flow/100;
  const x0=Math.floor(bx-rad-1), x1=Math.ceil(bx+rad+1);
  const y0=Math.floor(by-rad-1), y1=Math.ceil(by+rad+1);
  for(let py=Math.max(0,y0);py<=Math.min(m._bh-1,y1);py++){
    for(let px=Math.max(0,x0);px<=Math.min(m._bw-1,x1);px++){
      const d=Math.sqrt(((px-bx)/radX)**2+((py-by)/radY)**2);
      if(d>1)continue;
      // feathered falloff: hard=1 is hard edge, hard=0 is fully soft
      const inner=hard*(1-0.05); // tiny gap to avoid pure-square
      const t=d<=inner?1:clamp(1-(d-inner)/(1-inner+1e-6),0,1);
      const alpha=t*flow;
      const idx=py*m._bw+px;
      if(erasing) m._buf[idx]=clamp(m._buf[idx]-alpha,0,1);
      else m._buf[idx]=clamp(m._buf[idx]+alpha,0,1);
    }
  }
}

$('#addRadial').onclick=()=>addMask('radial');
$('#addLinear').onclick=()=>addMask('linear');
$('#addBrush').onclick=()=>addMask('brush');

function addMask(type){
  const p=sel(); if(!p){toast('Select a photo first');return;}
  pushHistory();
  const base={id:maskUid++,type,feather:50,inverted:false,adj:structuredClone(MASK_ADJ)};
  let m;
  if(type==='radial') m=Object.assign(base,{cx:0.5,cy:0.5,rx:0.3,ry:0.3});
  else if(type==='linear') m=Object.assign(base,{x1:0.5,y1:0.25,x2:0.5,y2:0.75});
  else m=base; // brush — buffer created lazily on first stroke
  p.masks.push(m); state.activeMask=p.masks.length-1;
  renderMasks(); selectMask(state.activeMask);
  if(type==='brush') getBrushBuf(p); // init buffer
  const labels={radial:'Radial — drag handles to position',linear:'Graduated — drag handles',brush:'Brush — paint on the photo'};
  toast(labels[type]||'');
}

function renderMasks(){
  const box=$('#maskList'); if(!box)return; box.innerHTML='';
  const p=sel(); if(!p)return;
  const labels={radial:'Radial',linear:'Graduated',brush:'Brush'};
  p.masks.forEach((m,i)=>{
    const el=document.createElement('div'); el.className='maskitem'+(i===state.activeMask?' on':'');
    el.innerHTML=`<span class="mi">${labels[m.type]||m.type} ${i+1}</span>
      <span class="mt">${m.inverted?'inv ':''}f${m.feather}</span>`;
    el.onclick=()=>selectMask(i);
    box.appendChild(el);
  });
  // show/hide brush controls
  const m=p.masks[state.activeMask];
  $('#brushControls').classList.toggle('hide', !(m&&m.type==='brush'));
  overlay.classList.toggle('live', state.activeMask>=0||state.spotMode||state.cropMode);
  if(m&&m.type==='brush') overlay.style.cursor='none'; else overlay.style.cursor='crosshair';
  drawOverlay();
}

function selectMask(i){
  state.activeMask=i; syncMaskSliders();
  $('#maskEditor').classList.remove('hide'); renderMasks();
  const p=sel(); const m=p&&p.masks[i];
  if(m&&m.type==='brush') getBrushBuf(p);
}
function closeMaskEditor(){ state.activeMask=-1; $('#maskEditor').classList.add('hide');
  overlay.classList.remove('live'); overlay.style.cursor='crosshair';
  if(octx)octx.clearRect(0,0,overlay.width,overlay.height);
  hideBrushCursor();
}
function maskValEl(k){ return $(`.val[data-mk="${k}"]`); }
function syncMaskSliders(){ const p=sel(); const m=p&&p.masks[state.activeMask]; if(!m)return;
  $$('input[type=range][data-mk]').forEach(inp=>{ const k=inp.dataset.mk;
    inp.value = k==='feather'?m.feather:m.adj[k]; updateMaskVal(k); }); }
function updateMaskVal(k){ const p=sel(); const m=p&&p.masks[state.activeMask]; if(!m)return;
  const el=maskValEl(k); if(!el)return; const v=k==='feather'?m.feather:m.adj[k];
  el.textContent = k==='exposure'?(+v).toFixed(2):(v>0?'+':'')+v; }
$$('input[type=range][data-mk]').forEach(inp=>{
  inp.addEventListener('input',()=>{ const p=sel(); if(!p||state.activeMask<0)return;
    const m=p.masks[state.activeMask], k=inp.dataset.mk;
    const v = k==='exposure'?parseFloat(inp.value):parseInt(inp.value);
    if(k==='feather')m.feather=v; else m.adj[k]=v; updateMaskVal(k);
    if(k==='feather')renderMasks(); scheduleRender(); });
});
$('#invertMask').onclick=()=>{ const p=sel(); if(!p||state.activeMask<0)return;
  pushHistory(); p.masks[state.activeMask].inverted=!p.masks[state.activeMask].inverted; renderMasks(); renderStage(); };
$('#deleteMask').onclick=()=>{ const p=sel(); if(!p||state.activeMask<0)return;
  pushHistory(); p.masks.splice(state.activeMask,1); closeMaskEditor(); renderMasks(); renderStage(); };

/* --- brush controls wiring --- */
$('#bmodePaint').onclick=()=>{ state.brush.erasing=false; $('#bmodePaint').classList.add('on'); $('#bmodeErase').classList.remove('on'); };
$('#bmodeErase').onclick=()=>{ state.brush.erasing=true; $('#bmodeErase').classList.add('on'); $('#bmodePaint').classList.remove('on'); };
$('#brushSize').oninput=e=>{ state.brush.size=+e.target.value; $('#bSizeVal').textContent=e.target.value; updateBrushCursorSize(); };
$('#brushHard').oninput=e=>{ state.brush.hardness=+e.target.value; $('#bHardVal').textContent=e.target.value; };
$('#brushFlow').oninput=e=>{ state.brush.flow=+e.target.value; $('#bFlowVal').textContent=e.target.value; };
$('#clearBrush').onclick=()=>{ const p=sel(); if(!p||state.activeMask<0)return;
  const m=p.masks[state.activeMask]; if(!m||m.type!=='brush')return;
  pushHistory(); if(m._buf)m._buf.fill(0); renderStage(); drawOverlay(); };

/* --- brush cursor ring --- */
const brushCursorEl=$('#brushCursor');
function showBrushCursor(x,y){ brushCursorEl.style.display='block';
  brushCursorEl.style.left=x+'px'; brushCursorEl.style.top=y+'px'; updateBrushCursorSize(); }
function hideBrushCursor(){ brushCursorEl.style.display='none'; }
function updateBrushCursorSize(){
  const sz=state.brush.size; brushCursorEl.style.width=sz+'px'; brushCursorEl.style.height=sz+'px'; }

/* --- drag mask handles on the overlay (radial/linear) + brush painting --- */
let mdrag=null, brushPainting=false;
overlay.addEventListener('pointerdown',e=>{
  if(state.cropMode){ handleCropDown(e); return; }
  if(state.spotMode){ handleSpotDown(e); return; }
  const p=sel(); if(!p||state.activeMask<0)return;
  const m=p.masks[state.activeMask];
  if(m.type==='brush'){
    brushPainting=true; beginGesture();
    overlay.setPointerCapture(e.pointerId);
    const [nx,ny]=c2n(e.offsetX,e.offsetY);
    getBrushBuf(p); paintDab(m,nx,ny,state.brush.erasing);
    drawOverlay(); scheduleRender(); return;
  }
  const mx=e.offsetX,my=e.offsetY;
  const hit=(cx,cy)=>Math.hypot(cx-mx,cy-my)<11;
  if(m.type==='radial'){
    const [cx,cy]=n2c(m.cx,m.cy);
    const rxp=m.rx*lastRegion.cw/lastRegion.sw*p.w, ryp=m.ry*lastRegion.ch/lastRegion.sh*p.h;
    if(hit(cx+rxp,cy))mdrag='rx'; else if(hit(cx,cy+ryp))mdrag='ry';
    else if(hit(cx,cy)||Math.hypot((mx-cx)/rxp,(my-cy)/ryp)<1)mdrag='move';
  } else {
    const [x1,y1]=n2c(m.x1,m.y1),[x2,y2]=n2c(m.x2,m.y2);
    if(hit(x1,y1))mdrag='a'; else if(hit(x2,y2))mdrag='b'; else mdrag='lmove';
    mdrag&&(dragRef={mx,my,m:JSON.parse(JSON.stringify(m))});
  }
  if(mdrag){ beginGesture(); overlay.setPointerCapture(e.pointerId); }
});
let dragRef=null;
overlay.addEventListener('pointermove',e=>{
  if(state.cropMode){ updateCropCursor(e); handleCropMove(e); return; }
  if(state.spotMode){ handleSpotMove(e); return; }
  const p=sel(); if(!p||state.activeMask<0)return;
  const m=p.masks[state.activeMask];
  // update brush cursor
  if(m.type==='brush'){
    const stageR=stage.getBoundingClientRect();
    showBrushCursor(e.clientX-stageR.left, e.clientY-stageR.top);
    if(brushPainting){
      const [nx,ny]=c2n(e.offsetX,e.offsetY);
      paintDab(m,nx,ny,state.brush.erasing);
      drawOverlay(); scheduleRender();
    }
    return;
  }
  if(!mdrag)return;
  const [nx,ny]=c2n(e.offsetX,e.offsetY);
  if(m.type==='radial'){
    if(mdrag==='move'){ m.cx=clamp(nx,0,1); m.cy=clamp(ny,0,1); }
    else if(mdrag==='rx'){ m.rx=clamp(Math.abs(nx-m.cx),0.02,1); }
    else if(mdrag==='ry'){ m.ry=clamp(Math.abs(ny-m.cy),0.02,1); }
  } else {
    if(mdrag==='a'){ m.x1=clamp(nx,0,1); m.y1=clamp(ny,0,1); }
    else if(mdrag==='b'){ m.x2=clamp(nx,0,1); m.y2=clamp(ny,0,1); }
    else if(mdrag==='lmove'&&dragRef){ const [rx,ry]=c2n(dragRef.mx,dragRef.my);
      const ddx=nx-rx, ddy=ny-ry; const o=dragRef.m;
      m.x1=clamp(o.x1+ddx,0,1); m.y1=clamp(o.y1+ddy,0,1);
      m.x2=clamp(o.x2+ddx,0,1); m.y2=clamp(o.y2+ddy,0,1); }
  }
  renderStage();
});
overlay.addEventListener('pointerup',()=>{
  if(state.cropMode){ handleCropUp(); return; }
  if(state.spotMode){ handleSpotUp(); return; }
  if(brushPainting){ brushPainting=false; endGesture(); }
  if(mdrag){ mdrag=null; dragRef=null; endGesture(); }
});
overlay.addEventListener('pointerleave',()=>hideBrushCursor());

/* square bracket keys resize brush */
window.addEventListener('keydown',e=>{
  if(e.target.tagName==='INPUT') return;
  if(e.key==='['){ const el=$('#brushSize'); el.value=Math.max(4,state.brush.size-10);
    el.dispatchEvent(new Event('input')); }
  if(e.key===']'){ const el=$('#brushSize'); el.value=Math.min(300,state.brush.size+10);
    el.dispatchEvent(new Event('input')); }
},{capture:false});

/* ============================================================
   CROP & STRAIGHTEN
   ============================================================ */
function enterCropMode(){
  const p=sel(); if(!p) return;
  // close competing tools
  if(state.spotMode) toggleSpotMode();
  closeMaskEditor();
  pushHistory();
  state.cropSnap = snapshot(p);
  if(!p.adj.crop) p.adj.crop = {l:0.04, t:0.04, r:0.96, b:0.96};
  state.cropMode = true;
  $('#cropBtn').classList.add('active');
  $('#cropstrip').classList.remove('hide');
  $('#cropAngle').value = p.adj.angle || 0;
  $('#cropAngleVal').textContent = (p.adj.angle||0).toFixed(1)+'°';
  overlay.classList.add('live'); overlay.style.cursor='crosshair';
  renderStage();
}
function exitCropMode(commit){
  const p=sel();
  if(!commit && p && state.cropSnap){
    restore(p, state.cropSnap);
  }
  state.cropMode=false; state.cropSnap=null; state._cropView=null;
  cropHandleDrag=null;
  $('#cropBtn').classList.remove('active');
  $('#cropstrip').classList.add('hide');
  overlay.classList.remove('live'); overlay.style.cursor='crosshair';
  renderStage();
}

$('#cropBtn').onclick    = ()=>{ if(state.cropMode) exitCropMode(true); else enterCropMode(); };
$('#cropDone').onclick   = ()=>exitCropMode(true);
$('#cropCancel').onclick = ()=>exitCropMode(false);
$('#cropReset').onclick  = ()=>{
  const p=sel(); if(!p) return;
  p.adj.crop={l:0,t:0,r:1,b:1}; p.adj.angle=0;
  $('#cropAngle').value=0; $('#cropAngleVal').textContent='0.0°';
  renderStage();
};
$('#cropFlipH').onclick = ()=>{
  const p=sel(); if(!p) return;
  p.adj.flipH=!p.adj.flipH; renderStage();
};
$('#cropAngle').oninput = e=>{
  const p=sel(); if(!p) return;
  p.adj.angle=parseFloat(e.target.value);
  $('#cropAngleVal').textContent=p.adj.angle.toFixed(1)+'°';
  scheduleRender();
};

/* crop drag interaction */
function handleCropDown(e){
  const p=sel(); if(!p||!state._cropView) return;
  const {cw,ch}=state._cropView;
  const crop=p.adj.crop||{l:0,t:0,r:1,b:1};
  // hit-test 8 handles
  for(const h of getCropHandles(crop,cw,ch)){
    if(Math.hypot(e.offsetX-h.x, e.offsetY-h.y)<22){
      cropHandleDrag={type:h.id, startX:e.offsetX, startY:e.offsetY, snap:{...crop}, cw, ch};
      overlay.setPointerCapture(e.pointerId); return;
    }
  }
  const x1=crop.l*cw, y1=crop.t*ch, x2=crop.r*cw, y2=crop.b*ch;
  if(e.offsetX>x1&&e.offsetX<x2&&e.offsetY>y1&&e.offsetY<y2){
    // drag to move the whole crop rect
    cropHandleDrag={type:'move', startX:e.offsetX, startY:e.offsetY, snap:{...crop}, cw, ch};
    overlay.setPointerCapture(e.pointerId); return;
  }
  // click outside → draw new crop rect
  cropHandleDrag={type:'new', startX:e.offsetX, startY:e.offsetY, cw, ch};
  overlay.setPointerCapture(e.pointerId);
}
const CROP_CURSORS={tl:'nw-resize',t:'n-resize',tr:'ne-resize',ml:'w-resize',mr:'e-resize',bl:'sw-resize',b:'s-resize',br:'se-resize'};
function updateCropCursor(e){
  if(!state.cropMode||!state._cropView)return;
  const {cw,ch}=state._cropView;
  const p=sel(); if(!p)return;
  const crop=p.adj.crop||{l:0,t:0,r:1,b:1};
  for(const h of getCropHandles(crop,cw,ch)){
    if(Math.hypot(e.offsetX-h.x,e.offsetY-h.y)<22){overlay.style.cursor=CROP_CURSORS[h.id]||'crosshair';return;}
  }
  const x1=crop.l*cw,y1=crop.t*ch,x2=crop.r*cw,y2=crop.b*ch;
  overlay.style.cursor=(e.offsetX>x1&&e.offsetX<x2&&e.offsetY>y1&&e.offsetY<y2)?'move':'crosshair';
}
function handleCropMove(e){
  if(!cropHandleDrag) return;
  const p=sel(); if(!p) return;
  const {cw,ch,snap,startX,startY}=cropHandleDrag;
  const MIN=0.04;
  const dnx=(e.offsetX-startX)/cw, dny=(e.offsetY-startY)/ch;
  let c=p.adj.crop ? {...p.adj.crop} : {l:0,t:0,r:1,b:1};
  const s=snap||c;
  switch(cropHandleDrag.type){
    case 'tl': c.l=clamp(s.l+dnx,0,s.r-MIN); c.t=clamp(s.t+dny,0,s.b-MIN); break;
    case 't':  c.t=clamp(s.t+dny,0,s.b-MIN); break;
    case 'tr': c.r=clamp(s.r+dnx,s.l+MIN,1); c.t=clamp(s.t+dny,0,s.b-MIN); break;
    case 'ml': c.l=clamp(s.l+dnx,0,s.r-MIN); break;
    case 'mr': c.r=clamp(s.r+dnx,s.l+MIN,1); break;
    case 'bl': c.l=clamp(s.l+dnx,0,s.r-MIN); c.b=clamp(s.b+dny,s.t+MIN,1); break;
    case 'b':  c.b=clamp(s.b+dny,s.t+MIN,1); break;
    case 'br': c.r=clamp(s.r+dnx,s.l+MIN,1); c.b=clamp(s.b+dny,s.t+MIN,1); break;
    case 'move':{
      const w=s.r-s.l, h=s.b-s.t;
      c.l=clamp(s.l+dnx,0,1-w); c.r=c.l+w;
      c.t=clamp(s.t+dny,0,1-h); c.b=c.t+h;
      break;
    }
    case 'new':{
      const nx=clamp(e.offsetX/cw,0,1), ny=clamp(e.offsetY/ch,0,1);
      const sx=startX/cw, sy=startY/ch;
      c={l:Math.min(sx,nx),t:Math.min(sy,ny),r:Math.max(sx,nx),b:Math.max(sy,ny)};
      if(c.r-c.l<0.01)c.r=c.l+0.01; if(c.b-c.t<0.01)c.b=c.t+0.01;
      break;
    }
  }
  p.adj.crop=c;
  octx.clearRect(0,0,overlay.width,overlay.height); drawCropOverlay();
  scheduleRender(80);
}
function handleCropUp(){
  if(cropHandleDrag){ cropHandleDrag=null; }
}

/* ============================================================
   SPOT REMOVAL
   ============================================================ */
function toggleSpotMode(){
  state.spotMode = !state.spotMode;
  $('#spotBtn').classList.toggle('spot-on', state.spotMode);
  $('#spotstrip').classList.toggle('hide', !state.spotMode);
  if(state.spotMode){
    // exit mask editing if active
    closeMaskEditor();
    overlay.classList.add('live');
    overlay.style.cursor = 'crosshair';
  } else {
    state.selSpot = null; state.spotDrag = null;
    overlay.classList.remove('live');
    overlay.style.cursor = 'crosshair';
  }
  drawOverlay();
}
$('#spotBtn').onclick = toggleSpotMode;
$('#spotDone').onclick = ()=>{ state.spotMode=false; $('#spotBtn').classList.remove('spot-on');
  $('#spotstrip').classList.add('hide'); state.selSpot=null; state.spotDrag=null;
  overlay.classList.remove('live'); drawOverlay(); };
$('#spotSize').oninput = e=>{
  $('#spotSizeVal').textContent = e.target.value;
  // resize selected spot live
  const p=sel(); if(!p||state.selSpot==null) return;
  const s=p.spots.find(x=>x.id===state.selSpot); if(!s) return;
  s.r = +e.target.value/1000;
  renderStage(); drawOverlay();
};

function handleSpotDown(e){
  const p=sel(); if(!p) return;
  const r=lastRegion; if(!r) return;
  const [nx,ny]=c2n(e.offsetX,e.offsetY);
  const rCvt=s=>s.r*p.w/r.sw*r.cw; // radius in canvas px

  // hit-test existing spots (destination circle first, then source)
  for(const spot of (p.spots||[])){
    const dstCx=(spot.cx*p.w-r.sx)/r.sw*r.cw, dstCy=(spot.cy*p.h-r.sy)/r.sh*r.ch;
    const srcCx=(spot.srcCx*p.w-r.sx)/r.sw*r.cw, srcCy=(spot.srcCy*p.h-r.sy)/r.sh*r.ch;
    const rPx=rCvt(spot)+6; // 6px grab margin
    if(Math.hypot(e.offsetX-dstCx, e.offsetY-dstCy)<=rPx){
      state.selSpot=spot.id;
      state.spotDrag={type:'dst',spotId:spot.id,startNx:nx,startNy:ny,
        origCx:spot.cx,origCy:spot.cy,origSrcCx:spot.srcCx,origSrcCy:spot.srcCy};
      beginGesture(); overlay.setPointerCapture(e.pointerId);
      drawOverlay(); return;
    }
    if(Math.hypot(e.offsetX-srcCx, e.offsetY-srcCy)<=rPx){
      state.selSpot=spot.id;
      state.spotDrag={type:'src',spotId:spot.id,startNx:nx,startNy:ny,
        origSrcCx:spot.srcCx,origSrcCy:spot.srcCy};
      beginGesture(); overlay.setPointerCapture(e.pointerId);
      drawOverlay(); return;
    }
  }

  // click on empty area → create new spot
  pushHistory();
  const newR = +$('#spotSize').value / 1000;
  // auto-offset source rightward; wrap left if near right edge
  let sNx = clamp(nx + newR*2.2, 0, 1);
  if(sNx > 0.9) sNx = clamp(nx - newR*2.2, 0, 1);
  const spot = {id:spotUid++, cx:nx, cy:ny, srcCx:sNx, srcCy:ny, r:newR};
  p.spots.push(spot);
  state.selSpot = spot.id;
  state.spotDrag = null;
  renderStage(); drawOverlay();
}

function handleSpotMove(e){
  const p=sel(); if(!p||!state.spotDrag) return;
  const [nx,ny]=c2n(e.offsetX,e.offsetY);
  const dd=state.spotDrag;
  const spot=p.spots.find(s=>s.id===dd.spotId); if(!spot) return;
  const dnx=nx-dd.startNx, dny=ny-dd.startNy;
  if(dd.type==='dst'){
    // move both dest and src together
    spot.cx =clamp(dd.origCx   +dnx, 0, 1); spot.cy   =clamp(dd.origCy   +dny, 0, 1);
    spot.srcCx=clamp(dd.origSrcCx+dnx, 0, 1); spot.srcCy=clamp(dd.origSrcCy+dny, 0, 1);
  } else {
    spot.srcCx=clamp(dd.origSrcCx+dnx, 0, 1); spot.srcCy=clamp(dd.origSrcCy+dny, 0, 1);
  }
  scheduleRender(); drawOverlay();
}

function handleSpotUp(){
  if(state.spotDrag){ state.spotDrag=null; endGesture(); }
}

/* ============================================================
   COPY / PASTE / SYNC
   ============================================================ */
$('#copySet').onclick=()=>{ const p=sel(); if(!p)return;
  state.clipboard={adj:structuredClone(p.adj),masks:structuredClone(p.masks)}; toast('Settings copied'); };
function pasteInto(p){ if(!state.clipboard)return;
  p.adj=structuredClone(state.clipboard.adj);
  p.masks=structuredClone(state.clipboard.masks).map(m=>(m.id=maskUid++,m)); }
$('#pasteSet').onclick=()=>{ const p=sel(); if(!p)return;
  if(!state.clipboard){toast('Copy a photo first');return;}
  pushHistory(); pasteInto(p); state.activeMask=-1; closeMaskEditor();
  syncSliders(); drawCurve(); renderMasks(); renderStage(); renderLooks(); toast('Settings pasted'); };
function syncTo(list,label){ if(!state.clipboard){toast('Copy a photo first');return;}
  list.forEach(p=>{ p._undo.push(snapshot(p)); p._redo.length=0; pasteInto(p); });
  syncSliders(); drawCurve(); renderMasks(); renderStage(); updateUndoButtons();
  toast('Synced to '+list.length+' '+label); }
$('#syncAll').onclick=()=>{ const p=sel(); if(p&&!state.clipboard)
    state.clipboard={adj:structuredClone(p.adj),masks:structuredClone(p.masks)};
  syncTo(state.photos.slice(),'photos'); };

/* photo-change reset */
function onPhotoChanged(){ state.activeMask=-1; state.view.mode='fit';
  state.selSpot=null; state.spotDrag=null;
  if(state.cropMode){ state.cropMode=false; state.cropSnap=null; state._cropView=null; cropHandleDrag=null;
    $('#cropBtn').classList.remove('active'); $('#cropstrip').classList.add('hide'); }
  closeMaskEditor(); updateZoomBtn(); renderMasks(); updateUndoButtons(); updateExifPanel(); }

/* ---------- delete photos (removes from memory + on-device storage) ---------- */
function deletePhotos(ids){
  const idSet=new Set(ids);
  state.photos.forEach(p=>{ if(idSet.has(p.id)&&p.bitmap&&p.bitmap.close) p.bitmap.close(); });
  state.photos=state.photos.filter(p=>!idSet.has(p.id));
  if(!IS_ELECTRON) ids.forEach(id=>{ idbDelete('files',id); idbDelete('edits',id); });
  state.multiSel.forEach(id=>{ if(idSet.has(id)) state.multiSel.delete(id); });
  if(idSet.has(state.selId)){
    state.selId = state.photos.length ? state.photos[0].id : null;
    onPhotoChanged();
  }
  renderThumbs(); renderStage(); renderLooks(); updateChrome();
  syncSliders(); drawCurve(); renderMasks();
  scheduleSessionSave();
  toast('Deleted '+ids.length+' photo'+(ids.length>1?'s':''));
}

/* ---------- boot ---------- */
renderPresets(); drawCurve(); renderLooks(); updateChrome(); updateZoomBtn(); updateUndoButtons();

/* ============================================================
   MOBILE NAVIGATION
   ============================================================ */
const MOB_TABS = ['tabView','tabFilm','tabEdit','tabLooks','tabMasks'];
function mobTab(tab){
  if(window.innerWidth > 768) return;
  if(tab!=='view') haptic(5);
  const filmbar=$('#filmbar');
  const right=document.querySelector('.col.right');
  if(filmbar) filmbar.classList.remove('mob-show');
  if(right) right.classList.remove('mob-show');
  stage.classList.remove('sheet-open','filmbar-open','strip-open');
  MOB_TABS.forEach(id=>{ const el=$('#'+id); if(el) el.classList.remove('on'); });

  if(tab==='film'){
    if(filmbar) filmbar.classList.add('mob-show');
    stage.classList.add('filmbar-open');
    $('#tabFilm').classList.add('on');
  } else if(tab==='edit'){
    if(right) right.classList.add('mob-show');
    stage.classList.add('sheet-open');
    $('#tabEdit').classList.add('on');
    showEditSubtab('light');
  } else if(tab==='looks'){
    if(right) right.classList.add('mob-show');
    stage.classList.add('sheet-open');
    $('#tabLooks').classList.add('on');
    showEditSubtab('looks');
  } else if(tab==='masks'){
    if(right) right.classList.add('mob-show');
    stage.classList.add('sheet-open');
    $('#tabMasks').classList.add('on');
    showEditSubtab('masks');
  } else {
    $('#tabView').classList.add('on');
  }
  scheduleRender();
}
$('#tabView').addEventListener('click', ()=>mobTab('view'));
$('#tabFilm').addEventListener('click', ()=>mobTab('film'));
$('#tabEdit').addEventListener('click', ()=>mobTab('edit'));
$('#tabLooks').addEventListener('click', ()=>mobTab('looks'));
$('#tabMasks').addEventListener('click', ()=>mobTab('masks'));

/* swipe left/right on the image stage to navigate between photos */
(()=>{
  let t0x=0, t0y=0;
  stage.addEventListener('touchstart', e=>{ t0x=e.touches[0].clientX; t0y=e.touches[0].clientY; }, {passive:true});
  stage.addEventListener('touchend', e=>{
    if(state.view.mode !== 'fit' || overlay.classList.contains('live')) return;
    const dx = e.changedTouches[0].clientX - t0x;
    const dy = e.changedTouches[0].clientY - t0y;
    if(Math.abs(dx) > 60 && Math.abs(dx) > Math.abs(dy) * 1.5){
      if(dx < 0) move(1); else move(-1);
    }
  }, {passive:true});
})();

/* ============================================================
   SESSION PERSISTENCE — Electron: native file (saveSession/loadSession)
                          Browser/PWA: IndexedDB (files + edits survive
                          closing and reopening the app)
   ============================================================ */
let sessionTimer=null;
function scheduleSessionSave(){
  clearTimeout(sessionTimer);
  sessionTimer=setTimeout(IS_ELECTRON?saveSession:saveSessionIDB, 1200);
}
async function saveSession(){
  if(!IS_ELECTRON||!state.photos.length)return;
  // save everything except bitmap (too large) — store file names + edits
  const data={
    version:2,
    photos: state.photos.map(p=>({
      name:p.name, w:p.w, h:p.h,
      adj:p.adj, masks:p.masks.map(m=>{
        // strip the Float32 buffer from brush masks (re-init on load)
        const {_buf,_lookSrc,...rest}=m; return rest;
      }),
      spots:p.spots||[],
    })),
    selId: state.selId,
    presets: state.presets,
  };
  await window.safelight.saveSession(data);
}

async function restoreSession(){
  if(!IS_ELECTRON)return;
  const data=await window.safelight.loadSession();
  if(!data||!data.photos||!data.version)return;
  // We can't restore bitmaps from the session (they weren't serialised),
  // so we show a "re-import" notice with the file list for now.
  // In the full desktop build this will re-read files from their saved paths.
  const names=data.photos.map(p=>p.name).slice(0,5).join(', ')+(data.photos.length>5?'…':'');
  toast(`Last session had ${data.photos.length} photo${data.photos.length>1?'s':''}: ${names} — re-import to restore`);
  // Restore presets which ARE serialisable
  if(data.presets) state.presets=[...data.presets];
  renderPresets();
}

/* ---- IndexedDB: keeps the original file bytes + edits on the device,
   so photos and adjustments survive closing/reopening the PWA ---- */
/* ============================================================
   MENU EVENTS FROM MAIN PROCESS
   ============================================================ */
if(IS_ELECTRON){
  window.safelight.onMenu((ev,...args)=>{
    switch(ev){
      case 'menu:export':     openExport(args[0]); break;
      case 'menu:saveSession':saveSession(); toast('Session saved'); break;
      case 'menu:clearSession':state.photos=[]; state.selId=null; renderThumbs(); renderStage(); updateChrome(); toast('Session cleared'); break;
      case 'menu:undo':       undo(); break;
      case 'menu:redo':       redo(); break;
      case 'menu:copy':       $('#copySet').click(); break;
      case 'menu:paste':      $('#pasteSet').click(); break;
      case 'menu:autotone':   $('#autoEdit').click(); break;
      case 'menu:reset':      $('#resetEdit').click(); break;
      case 'menu:nav':        move(args[0]); break;
      case 'menu:zoom':       toggleZoom(); break;
      case 'menu:before':     before(!state.showBefore); break;
      case 'menu:shortcuts':  showShortcuts(); break;
    }
  });
}

/* ============================================================
   KEYBOARD SHORTCUTS MODAL
   ============================================================ */
function showShortcuts(){
  const existing=$('#shortcutsModal');
  if(existing){ existing.remove(); return; }
  const m=document.createElement('div');
  m.id='shortcutsModal';
  m.style.cssText='position:fixed;inset:0;background:rgba(0,0,0,.7);display:flex;align-items:center;justify-content:center;z-index:100;backdrop-filter:blur(4px)';
  m.innerHTML=`<div style="background:var(--panel);border:1px solid var(--line);border-radius:14px;padding:28px 32px;min-width:340px;max-height:80vh;overflow-y:auto">
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:18px">
      <span style="font-weight:700;font-size:15px">Keyboard Shortcuts</span>
      <button onclick="this.closest('#shortcutsModal').remove()" style="border:0;background:0;color:var(--muted);font-size:18px;cursor:pointer">✕</button>
    </div>
    ${[
      ['Navigation',''],
      ['← / →','Previous / Next photo'],
      ['Z','Toggle 100% zoom'],
      ['B (hold)','Before / After'],
      ['Develop',''],
      ['A','Auto-tone'],
      ['Ctrl+Z / Ctrl+Y','Undo / Redo'],
      ['[ / ]','Brush size smaller / larger'],
      ['Export',''],
      ['Ctrl+E','Export selected'],
    ].map(([k,v])=>k&&!v
      ? `<div style="font-size:10px;text-transform:uppercase;letter-spacing:.1em;color:var(--faint);margin:12px 0 4px">${k}</div>`
      : `<div style="display:flex;justify-content:space-between;padding:4px 0;border-bottom:1px solid var(--line);font-size:12px">
           <kbd style="font-family:var(--mono);background:var(--panel-2);border:1px solid var(--line);border-radius:4px;padding:1px 6px;font-size:11px">${k}</kbd>
           <span style="color:var(--muted)">${v}</span></div>`
    ).join('')}
  </div>`;
  m.onclick=e=>{ if(e.target===m)m.remove(); };
  document.body.appendChild(m);
}

/* ============================================================
   ELECTRON STARTUP
   ============================================================ */
if(IS_ELECTRON){
  (async()=>{
    const prefs=await window.safelight.getPrefs();
    if(prefs.theme){
      $$('#themeGrid .subtab').forEach(b=>b.classList.toggle('on', b.dataset.theme===prefs.theme));
      document.documentElement.dataset.theme=prefs.theme;
      drawCurve(); renderLooks();
    }
    await restoreSession();
  })();
} else {
  if(navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(()=>{});
  restoreSessionIDB();
}

/* ============================================================
   RATINGS & FLAGS
   ============================================================ */
function setFlag(v){const p=sel();if(!p)return;p.flag=v;renderThumbs();scheduleSessionSave();toast(v===1?'Picked':v===-1?'Rejected':'Unflagged');}
function setRating(v){const p=sel();if(!p)return;p.rating=v;haptic(v?[10,30,10]:8);renderThumbs();scheduleSessionSave();toast('Rating: '+v+(v?'★':''));}
function toggleFullscreen(){
  if(!document.fullscreenElement) document.documentElement.requestFullscreen().catch(()=>{});
  else document.exitFullscreen();
}

/* ============================================================
   SORT / FILTER WIRING
   ============================================================ */
$('#sortSel').addEventListener('change',e=>{ state.sort=e.target.value; renderThumbs(); });
const FILTER_MODES=['all','picks','rejects','rated'];
const FILTER_LABELS={all:'All',picks:'Picks',rejects:'Rejects',rated:'Rated 3+'};
$('#filterBtn').addEventListener('click',()=>{
  const idx=FILTER_MODES.indexOf(state.filterMode);
  state.filterMode=FILTER_MODES[(idx+1)%FILTER_MODES.length];
  $('#filterBtn').textContent=FILTER_LABELS[state.filterMode];
  renderThumbs();
});

/* ============================================================
   COMPARE MODE
   ============================================================ */
let compareLineEl=null;
let compareDragging=false;
function toggleCompareMode(){
  state.compareMode=!state.compareMode;
  const btn=$('#compareBtn');
  if(btn)btn.classList.toggle('active',state.compareMode);
  if(!state.compareMode&&compareLineEl){compareLineEl.remove();compareLineEl=null;}
  renderStage();
}
$('#compareBtn').onclick=toggleCompareMode;

function drawCompareSplit(){
  const p=sel(); if(!p||!state.compareMode)return;
  const wrap=$('#viewwrap');
  if(!compareLineEl){
    compareLineEl=document.createElement('div');
    compareLineEl.className='compare-line';
    compareLineEl.style.cssText='position:absolute;top:0;bottom:0;width:3px;background:rgba(255,255,255,.85);cursor:ew-resize;z-index:5;transform:translateX(-50%);pointer-events:auto';
    if(wrap)wrap.appendChild(compareLineEl);
    compareLineEl.addEventListener('pointerdown',e=>{
      compareDragging=true;compareLineEl.setPointerCapture(e.pointerId);e.stopPropagation();
    });
    compareLineEl.addEventListener('pointermove',e=>{
      if(!compareDragging)return;
      const r=wrap.getBoundingClientRect();
      state.compareSplitX=clamp((e.clientX-r.left)/r.width,0.05,0.95);
      compareLineEl.style.left=(state.compareSplitX*100)+'%';
      renderStage();
    });
    compareLineEl.addEventListener('pointerup',()=>{compareDragging=false;});
  }
  const splitPct=(state.compareSplitX*100)+'%';
  compareLineEl.style.left=splitPct;
  // draw left half as "before" (original), right half as edited
  const w=displayCanvas.width, h=displayCanvas.height;
  const splitX=Math.round(state.compareSplitX*w);
  // capture edited right half
  const rightData=displayCtx.getImageData(splitX,0,w-splitX,h);
  // draw original on left half
  const tmp=document.createElement('canvas'); tmp.width=w; tmp.height=h;
  const tx=tmp.getContext('2d');
  tx.drawImage(p.bitmap,0,0,p.w,p.h,0,0,w,h);
  displayCtx.drawImage(tmp,0,0,splitX,h,0,0,splitX,h);
  displayCtx.putImageData(rightData,splitX,0);
  // labels
  displayCtx.save();
  displayCtx.font='bold 13px sans-serif';
  displayCtx.fillStyle='rgba(255,255,255,.8)';
  displayCtx.fillText('BEFORE',14,22);
  displayCtx.fillText('AFTER',splitX+10,22);
  displayCtx.restore();
}

/* ============================================================
   HSL PANEL
   ============================================================ */
const HSL_RANGES=['red','orange','yellow','green','aqua','blue','purple','magenta'];
function renderHSLPanel(){
  const box=$('#hslBody'); if(!box)return;
  if(box.querySelectorAll('.slider').length>0)return;
  const colors={red:'#e84058',orange:'#e8a24a',yellow:'#d4c840',green:'#50d48c',aqua:'#50c8e8',blue:'#508ceb',purple:'#a07ef0',magenta:'#d45090'};
  HSL_RANGES.forEach(range=>{
    const section=document.createElement('div');
    section.innerHTML=`<div class="grp-h" style="color:${colors[range]||'var(--muted)'};text-transform:capitalize">${range}</div>
      <div class="slider"><div class="top"><label>Hue</label><span class="val" id="hsl_${range}_h">0</span></div><input type="range" id="hsl_${range}_h_inp" min="-180" max="180" value="0"></div>
      <div class="slider"><div class="top"><label>Saturation</label><span class="val" id="hsl_${range}_s">0</span></div><input type="range" id="hsl_${range}_s_inp" min="-100" max="100" value="0"></div>
      <div class="slider"><div class="top"><label>Luminance</label><span class="val" id="hsl_${range}_l">0</span></div><input type="range" id="hsl_${range}_l_inp" min="-100" max="100" value="0"></div>`;
    box.appendChild(section);
    ['h','s','l'].forEach(ch=>{
      const inp=section.querySelector('#hsl_'+range+'_'+ch+'_inp');
      const val=section.querySelector('#hsl_'+range+'_'+ch);
      inp.addEventListener('input',()=>{
        const p=sel(); if(!p)return;
        if(!p.adj.hsl) p.adj.hsl=structuredClone(DEFAULT_ADJ.hsl);
        p.adj.hsl[range][ch]=parseInt(inp.value);
        val.textContent=(parseInt(inp.value)>0?'+':'')+inp.value;
        scheduleRender();
      });
      inp.addEventListener('pointerdown',beginGesture);
      inp.addEventListener('change',endGesture);
    });
  });
}
function syncHSLPanel(){
  const p=sel(); if(!p)return;
  HSL_RANGES.forEach(range=>{
    const hsl=p.adj.hsl&&p.adj.hsl[range]||{h:0,s:0,l:0};
    ['h','s','l'].forEach(ch=>{
      const inp=$('#hsl_'+range+'_'+ch+'_inp');
      const val=$('#hsl_'+range+'_'+ch);
      if(inp){inp.value=hsl[ch]; setSliderFill(inp); val.textContent=(hsl[ch]>0?'+':'')+hsl[ch];}
    });
  });
}
// Build HSL panel when its accordion section is first opened
(function(){
  const hslSec=$(`.acc-section[data-sec="hsl"]`);
  if(!hslSec) return;
  hslSec.querySelector('.acc-head').addEventListener('click',()=>{
    renderHSLPanel(); syncHSLPanel();
  });
  // also build it immediately so it's ready if opened programmatically
  renderHSLPanel();
})();

/* ============================================================
   SPLIT TONE WIRING
   ============================================================ */
function syncSplitTone(){
  const p=sel(); if(!p||!p.adj.splitTone)return;
  const st=p.adj.splitTone;
  const sh=$('#stShadowHue'),ss=$('#stShadowSat'),hh=$('#stHighlightHue'),hs=$('#stHighlightSat'),bal=$('#stBalance');
  if(sh){sh.value=st.shadowHue; $('#stShadowHueVal').textContent=st.shadowHue; setSliderFill(sh);}
  if(ss){ss.value=st.shadowSat; $('#stShadowSatVal').textContent=st.shadowSat; setSliderFill(ss);}
  if(hh){hh.value=st.highlightHue; $('#stHighlightHueVal').textContent=st.highlightHue; setSliderFill(hh);}
  if(hs){hs.value=st.highlightSat; $('#stHighlightSatVal').textContent=st.highlightSat; setSliderFill(hs);}
  if(bal){bal.value=st.balance; $('#stBalanceVal').textContent=st.balance; setSliderFill(bal);}
}
['stShadowHue','stShadowSat','stHighlightHue','stHighlightSat','stBalance'].forEach(id=>{
  const el=$('#'+id); if(!el)return;
  el.addEventListener('pointerdown',beginGesture);
  el.addEventListener('change',endGesture);
  el.addEventListener('input',()=>{
    const p=sel(); if(!p)return;
    if(!p.adj.splitTone) p.adj.splitTone=structuredClone(DEFAULT_ADJ.splitTone);
    const map={stShadowHue:'shadowHue',stShadowSat:'shadowSat',stHighlightHue:'highlightHue',stHighlightSat:'highlightSat',stBalance:'balance'};
    p.adj.splitTone[map[id]]=parseInt(el.value);
    $('#'+id+'Val').textContent=el.value;
    scheduleRender();
  });
});

/* ============================================================
   RGB CURVE CHANNEL SELECTOR
   ============================================================ */
$$('.curve-ch').forEach(b=>b.onclick=()=>{
  state.curveChannel=b.dataset.ch;
  $$('.curve-ch').forEach(x=>x.classList.remove('on'));
  b.classList.add('on');
  drawCurve();
});

/* ============================================================
   COLLECTIONS
   ============================================================ */
$('#addCollectionBtn').onclick=()=>{
  const name=prompt('Collection name');
  if(!name)return;
  const id=Date.now();
  state.collections.push({id,name});
  renderCollections();
  toast('Collection "'+name+'" created');
};
function toggleCollectionsPanel(){
  const panel=$('#collectionsPanel');
  const shown=panel.style.display==='flex';
  panel.style.display=shown?'none':'flex';
  const colBtn=$('#showCollectionsBtn'); if(colBtn) colBtn.classList.toggle('active',!shown);
}
$('#toggleCollectionsBtn').onclick=toggleCollectionsPanel;
$('#showCollectionsBtn').onclick=toggleCollectionsPanel;
function renderCollections(){
  const box=$('#collectionList'); if(!box)return;
  box.innerHTML='';
  const allBtn=document.createElement('button');
  allBtn.className='ghost'+(state.activeCollection==null?' active':'');
  allBtn.style.cssText='font-size:10px;padding:3px 8px;min-height:0;width:100%;text-align:left;margin-bottom:2px';
  allBtn.textContent='All Photos';
  allBtn.onclick=()=>{state.activeCollection=null;renderCollections();renderThumbs();};
  box.appendChild(allBtn);
  state.collections.forEach(col=>{
    const btn=document.createElement('button');
    btn.className='ghost'+(state.activeCollection===col.id?' active':'');
    btn.style.cssText='font-size:10px;padding:3px 8px;min-height:0;width:100%;text-align:left;margin-bottom:2px';
    btn.textContent=col.name;
    btn.onclick=()=>{state.activeCollection=col.id;renderCollections();renderThumbs();};
    box.appendChild(btn);
  });
}
function addToCollectionMenu(p,e){
  e.preventDefault();
  if(!state.collections.length){toast('Create a collection first (filmstrip → Collections)');return;}
  const existing=document.querySelector('.ctx-menu'); if(existing)existing.remove();
  const menu=document.createElement('div');
  menu.className='ctx-menu';
  menu.style.cssText='position:fixed;background:var(--panel);border:1px solid var(--line);border-radius:8px;z-index:200;padding:4px;min-width:160px';
  menu.style.left=e.clientX+'px'; menu.style.top=e.clientY+'px';
  state.collections.forEach(col=>{
    const btn=document.createElement('button');
    btn.style.cssText='display:block;width:100%;text-align:left;border:0;background:transparent;padding:6px 10px;font-family:inherit;font-size:12px;color:var(--ink);cursor:pointer;border-radius:5px';
    const inCol=p.collections&&p.collections.has(col.id);
    btn.textContent=(inCol?'✓ ':'')+col.name;
    btn.onmouseenter=()=>btn.style.background='var(--panel-2)';
    btn.onmouseleave=()=>btn.style.background='transparent';
    btn.onclick=()=>{
      if(!p.collections) p.collections=new Set();
      if(inCol) p.collections.delete(col.id); else p.collections.add(col.id);
      menu.remove(); renderThumbs();
    };
    menu.appendChild(btn);
  });
  document.body.appendChild(menu);
  setTimeout(()=>document.addEventListener('click',()=>menu.remove(),{once:true}),0);
}

/* ============================================================
   WATERMARK UI WIRING
   ============================================================ */
$('#wmEnabled').onchange=e=>{ state.watermark.enabled=e.target.checked; };
$('#wmText').oninput=e=>{ state.watermark.text=e.target.value; };
$$('.wm-pos').forEach(b=>b.onclick=()=>{
  state.watermark.position=b.dataset.pos;
  $$('.wm-pos').forEach(x=>x.classList.remove('on'));
  b.classList.add('on');
});
$('#wmOpacity').oninput=e=>{ state.watermark.opacity=+e.target.value/100; $('#wmOpacityVal').textContent=e.target.value; };
$('#wmSize').oninput=e=>{ state.watermark.size=+e.target.value; $('#wmSizeVal').textContent=e.target.value; };

/* ============================================================
   RESIZE ON EXPORT WIRING
   ============================================================ */
$('#resizeEnabled').onchange=e=>{ state.exportResize.enabled=e.target.checked; };
$('#resizeLongEdge').oninput=e=>{ state.exportResize.longEdge=+e.target.value; };

/* ============================================================
   CROP ASPECT RATIO BUTTONS
   ============================================================ */
let cropAspect=null;
$('#cropFree').onclick=()=>{cropAspect=null;};
$('#crop11').onclick=()=>{cropAspect=[1,1];applyCropAspect();};
$('#crop45').onclick=()=>{cropAspect=[4,5];applyCropAspect();};
$('#crop32').onclick=()=>{cropAspect=[3,2];applyCropAspect();};
$('#crop169').onclick=()=>{cropAspect=[16,9];applyCropAspect();};
$('#crop43').onclick=()=>{cropAspect=[4,3];applyCropAspect();};
function applyCropAspect(){
  if(!cropAspect)return;
  const p=sel(); if(!p)return;
  const c=p.adj.crop||{l:0,t:0,r:1,b:1};
  const {rotW,rotH}=rotatedBounds(p);
  const cw=(c.r-c.l)*rotW, ch=(c.b-c.t)*rotH;
  const targetAr=cropAspect[0]/cropAspect[1];
  const curAr=cw/ch;
  let nl=c.l,nt=c.t,nr=c.r,nb=c.b;
  if(curAr>targetAr){
    const newCw=ch*targetAr;
    const cx=(c.l+c.r)/2;
    nl=cx-newCw/rotW/2; nr=cx+newCw/rotW/2;
  } else {
    const newCh=cw/targetAr;
    const cy=(c.t+c.b)/2;
    nt=cy-newCh/rotH/2; nb=cy+newCh/rotH/2;
  }
  p.adj.crop={l:clamp(nl,0,1),t:clamp(nt,0,1),r:clamp(nr,0,1),b:clamp(nb,0,1)};
  renderStage();
}

/* ============================================================
   EXIF INFO PANEL
   ============================================================ */
function updateExifPanel(){
  const box=$('#exifPanel'); if(!box)return;
  const p=sel();
  if(!p||!p.exif||!Object.keys(p.exif).length){
    box.innerHTML='<span style="color:var(--faint)">No EXIF data available.</span>'; return;
  }
  const e=p.exif;
  const rows=[
    e.make&&['Camera',e.make+(e.model?' '+e.model:'')],
    e.exposureTime&&['Exposure',e.exposureTime+'s'],
    e.fNumber&&['Aperture','f/'+e.fNumber],
    e.iso&&['ISO',e.iso],
    e.focalLength&&['Focal Length',e.focalLength],
    e.dateTime&&['Date',e.dateTime],
    ['Dimensions',p.w+'×'+p.h],
  ].filter(Boolean);
  box.innerHTML=rows.map(([k,v])=>`<div style="display:flex;gap:12px;padding:2px 0;border-bottom:1px solid var(--line)"><span style="color:var(--faint);min-width:90px">${k}</span><span style="color:var(--ink)">${v}</span></div>`).join('');
}

/* ============================================================
   PINCH TO ZOOM
   ============================================================ */
let pinchStartDist=0;
stage.addEventListener('touchstart',e=>{
  if(e.touches.length===2){
    pinchStartDist=Math.hypot(e.touches[0].clientX-e.touches[1].clientX,e.touches[0].clientY-e.touches[1].clientY);
  }
},{passive:true});
stage.addEventListener('touchmove',e=>{
  if(e.touches.length===2&&pinchStartDist>0){
    const d=Math.hypot(e.touches[0].clientX-e.touches[1].clientX,e.touches[0].clientY-e.touches[1].clientY);
    if(d/pinchStartDist>1.3){toggleZoom();pinchStartDist=d;}
    else if(d/pinchStartDist<0.7){toggleZoom();pinchStartDist=d;}
  }
},{passive:true});

