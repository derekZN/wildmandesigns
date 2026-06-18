"use strict";
/* WildmanDesigns — mobile Lightroom-style UI */
(function initMobUI(){
  if(window.innerWidth > 768) return;

  const G=id=>document.getElementById(id);
  const QA=sel=>[...document.querySelectorAll(sel)];

  /* ── SIDEBAR ── */
  const sidebar=G('sidebar'), sidebarOv=G('sidebarOverlay');
  function openSidebar(){ sidebar&&sidebar.classList.add('open'); sidebarOv&&sidebarOv.classList.add('open'); }
  function closeSidebar(){ sidebar&&sidebar.classList.remove('open'); sidebarOv&&sidebarOv.classList.remove('open'); }
  G('libHamburger')&&G('libHamburger').addEventListener('click',openSidebar);
  sidebarOv&&sidebarOv.addEventListener('click',closeSidebar);
  G('sidebarImport')&&G('sidebarImport').addEventListener('click',()=>{ closeSidebar(); G('file').click(); });
  G('sidebarExport')&&G('sidebarExport').addEventListener('click',()=>{ closeSidebar(); openExport(); });
  G('sidebarSettings')&&G('sidebarSettings').addEventListener('click',()=>{ closeSidebar(); G('settingsModal').classList.remove('hide'); });
  G('sidebarClear')&&G('sidebarClear').addEventListener('click',()=>{
    closeSidebar();
    if(!state.photos.length){toast('No photos to clear');return;}
    if(!confirm('Delete all '+state.photos.length+' photos?'))return;
    deletePhotos(state.photos.map(p=>p.id));
  });

  /* ── LIBRARY / EDITOR SWITCHING ── */
  const libView=G('libView'), libBotNav=G('libBottomNav'), mobEditView=G('mobEditView'), mobEditImage=G('mobEditImage');

  function showLibrary(){
    libView&&libView.classList.add('active');
    libBotNav&&libBotNav.classList.add('active');
    mobEditView&&mobEditView.classList.remove('active');
    // Clear the mob view canvas when going back to library
    const mv=G('mobView'); if(mv){mv.width=1;mv.height=1;}
  }

  function showEditor(){
    libView&&libView.classList.remove('active');
    libBotNav&&libBotNav.classList.remove('active');
    mobEditView&&mobEditView.classList.add('active');
    // #mobView in #mobEditImage gets the mirrored image from renderStage — no canvas moving needed
    requestAnimationFrame(()=>{ renderStage(); renderMobPresets(); renderMobEditSliders(_mobCat); });
  }

  /* ── LIBRARY GRID ── */
  const libGrid=G('libGrid'), libEmpty=G('libEmpty');
  function renderLibGrid(){
    if(!libGrid) return;
    if(libEmpty) libEmpty.style.display=state.photos.length?'none':'';
    QA('#libGrid .year-group').forEach(el=>el.remove());
    if(!state.photos.length) return;
    const groups={};
    state.photos.forEach(p=>{ const yr=p.exif&&p.exif.dateTime?p.exif.dateTime.substring(0,4):'Recent'; if(!groups[yr])groups[yr]=[]; groups[yr].push(p); });
    Object.keys(groups).sort((a,b)=>b.localeCompare(a)).forEach(yr=>{
      const photos=groups[yr];
      const group=document.createElement('div'); group.className='year-group';
      const hdr=document.createElement('div'); hdr.className='year-header';
      hdr.innerHTML=yr+'<span class="year-header-right">'+photos.length+' <span style="font-size:18px">›</span></span>';
      group.appendChild(hdr);
      const grid=document.createElement('div'); grid.className='year-photos';
      photos.forEach((p,i)=>{
        const tile=document.createElement('div'); tile.className='lib-photo'+(i%7===3?' wide':'');
        const lps=document.createElement('div'); lps.className='lp-sel'; tile.appendChild(lps);
        const lpb=document.createElement('div'); lpb.className='lp-badge'; tile.appendChild(lpb);
        if(p.thumb&&p.thumb.width>0){try{const _img=document.createElement('img');_img.src=p.thumb.toDataURL();_img.style.cssText='position:absolute;top:0;left:0;width:100%;height:100%;object-fit:cover;display:block';tile.insertBefore(_img,lps);}catch(e){}}
        tile.addEventListener('click',()=>{
          state.selId=p.id; onPhotoChanged(); renderThumbs(); renderStage(); syncSliders(); drawCurve(); renderLooks(); updateChrome();
          showEditor(); activateMobTool('edit');
        });
        grid.appendChild(tile);
      });
      group.appendChild(grid);
      libGrid.insertBefore(group,libEmpty);
    });
  }

  G('libFabImport')&&G('libFabImport').addEventListener('click',()=>G('file').click());
  G('mobEditBack')&&G('mobEditBack').addEventListener('click',()=>{ showLibrary(); renderLibGrid(); });
  G('mobEditShare')&&G('mobEditShare').addEventListener('click',openExport);
  G('mobEditUndo')&&G('mobEditUndo').addEventListener('click',()=>G('undoBtn').click());

  /* ── 6-TAB TOOL BAR ── */
  function activateMobTool(tool){
    QA('.mob-tool-tab').forEach(t=>t.classList.remove('on'));
    QA('.mob-tool-panel').forEach(p=>p.classList.remove('active'));
    const tid='mobTab'+tool.charAt(0).toUpperCase()+tool.slice(1);
    const pid='panel'+tool.charAt(0).toUpperCase()+tool.slice(1);
    G(tid)&&G(tid).classList.add('on'); G(pid)&&G(pid).classList.add('active');
    if(tool==='crop'){ enterCropMode(); }
    else if(state.cropMode){ exitCropMode(false); }
    if(tool==='remove'){ if(!state.spotMode)toggleSpotMode(); }
    else if(state.spotMode){ toggleSpotMode(); }
    if(tool==='edit') renderMobEditSliders(_mobCat);
    // Re-render after panel height changes
    requestAnimationFrame(()=>renderStage());
  }
  QA('.mob-tool-tab').forEach(tab=>tab.addEventListener('click',()=>activateMobTool(tab.dataset.tool)));

  /* ── ACTIONS ── */
  G('actAuto')&&G('actAuto').addEventListener('click',()=>{ G('autoEdit').click(); toast('Auto-tone applied'); });
  G('actEnhance')&&G('actEnhance').addEventListener('click',()=>{ G('autoEdit').click(); toast('Enhanced'); });
  G('actFixAngle')&&G('actFixAngle').addEventListener('click',()=>activateMobTool('crop'));
  G('actSubject')&&G('actSubject').addEventListener('click',()=>toast('Subject masking — use Masking tab'));
  G('actBackground')&&G('actBackground').addEventListener('click',()=>toast('Background tool coming soon'));

  /* ── EDIT PANEL ── */
  const EDIT_CATS={
    light:[{l:'Exposure',k:'exposure',mn:-2,mx:2,st:0.01},{l:'Contrast',k:'contrast',mn:-100,mx:100},{l:'Highlights',k:'highlights',mn:-100,mx:100},{l:'Shadows',k:'shadows',mn:-100,mx:100},{l:'Whites',k:'whites',mn:-100,mx:100},{l:'Blacks',k:'blacks',mn:-100,mx:100}],
    color:[{l:'Temperature',k:'temp',mn:-100,mx:100},{l:'Tint',k:'tint',mn:-100,mx:100},{l:'Vibrance',k:'vibrance',mn:-100,mx:100},{l:'Saturation',k:'saturation',mn:-100,mx:100}],
    effects:[{l:'Clarity',k:'clarity',mn:-100,mx:100},{l:'Dehaze',k:'dehaze',mn:-100,mx:100}],
    detail:[{l:'Sharpening',k:'sharpen',mn:0,mx:100},{l:'Luminance NR',k:'denoiseL',mn:0,mx:100},{l:'Color NR',k:'denoiseC',mn:0,mx:100}],
    optics:[{l:'Distortion',k:'distort',mn:-100,mx:100},{l:'Vignette',k:'vignette2',mn:-100,mx:0},{l:'Vertical',k:'vertPersp',mn:-100,mx:100},{l:'Horizontal',k:'horizPersp',mn:-100,mx:100}],
  };
  let _mobCat='light';

  function renderMobEditSliders(cat){
    _mobCat=cat; const box=G('mobEditSliders'); if(!box)return; box.innerHTML='';
    const p=sel();
    (EDIT_CATS[cat]||[]).forEach(def=>{
      const v=p?(p.adj[def.k]!=null?p.adj[def.k]:0):0;
      const pct=((v-def.mn)/(def.mx-def.mn)*100).toFixed(1);
      const row=document.createElement('div'); row.className='mob-edit-slider';
      row.innerHTML='<div class="top"><label>'+def.l+'</label><span class="val">'+(def.k==='exposure'?v.toFixed(2):(v>0?'+':'')+v)+'</span></div><input type="range" min="'+def.mn+'" max="'+def.mx+'" step="'+(def.st||1)+'" value="'+v+'" style="--fill:'+pct+'%">';
      const inp=row.querySelector('input');
      inp.addEventListener('input',()=>{
        const ph=sel(); if(!ph)return;
        ph.adj[def.k]=def.k==='exposure'?parseFloat(inp.value):parseInt(inp.value);
        const nv=ph.adj[def.k]; row.querySelector('.val').textContent=def.k==='exposure'?nv.toFixed(2):(nv>0?'+':'')+nv;
        setSliderFill(inp); scheduleRender();
      });
      setSliderFill(inp); box.appendChild(row);
    });
  }

  document.addEventListener('click',e=>{
    const cat=e.target.closest('.mob-edit-cat'); if(!cat)return;
    QA('.mob-edit-cat').forEach(c=>c.classList.remove('on')); cat.classList.add('on');
    renderMobEditSliders(cat.dataset.ec);
  });

  /* ── PRESETS PANEL ── */
  function renderMobPresets(){
    const ph=sel();
    function makeList(box,cats){
      if(!box)return; box.innerHTML='';
      cats.forEach(cat=>{
        const items=BUILTIN_PRESETS.filter(b=>b.cat===cat); if(!items.length)return;
        const row=document.createElement('div'); row.className='preset-list-item';
        const thumb=document.createElement('div'); thumb.className='preset-list-thumb';
        if(ph){ const DPR=Math.min(window.devicePixelRatio||1,2);const src=lookSource(ph);const cv=document.createElement('canvas');cv.width=52*DPR;cv.height=52*DPR;cv.style.width='52px';cv.style.height='52px';const x=cv.getContext('2d',{willReadFrequently:true});x.drawImage(src.canvas,0,0,src.w,src.h,0,0,52*DPR,52*DPR);const img=x.getImageData(0,0,52*DPR,52*DPR);processImageData(img,items[0].adj);x.putImageData(img,0,0);thumb.appendChild(cv); }
        const name=document.createElement('div'); name.className='preset-list-name'; name.textContent=cat;
        const cnt=document.createElement('div'); cnt.className='preset-list-count'; cnt.textContent=items.length;
        const arr=document.createElement('div'); arr.className='preset-list-arrow'; arr.textContent='›';
        row.appendChild(thumb); row.appendChild(name); row.appendChild(cnt); row.appendChild(arr);
        row.addEventListener('click',()=>{
          const sub=row.nextElementSibling; if(sub&&sub.classList.contains('preset-sub')){ sub.remove(); return; }
          const subBox=document.createElement('div'); subBox.className='preset-sub';
          items.forEach(lk=>{
            const s=document.createElement('div'); s.style.cssText='display:flex;align-items:center;gap:10px;padding:10px 16px;cursor:pointer;border-bottom:1px solid rgba(255,255,255,.05)';
            const tc=document.createElement('div'); tc.style.cssText='width:40px;height:40px;border-radius:5px;overflow:hidden;background:#333;flex-shrink:0';
            if(ph){const DPR2=Math.min(window.devicePixelRatio||1,2);const src2=lookSource(ph);const cv2=document.createElement('canvas');cv2.width=40*DPR2;cv2.height=40*DPR2;cv2.style.width='40px';cv2.style.height='40px';const x2=cv2.getContext('2d',{willReadFrequently:true});x2.drawImage(src2.canvas,0,0,src2.w,src2.h,0,0,40*DPR2,40*DPR2);const img2=x2.getImageData(0,0,40*DPR2,40*DPR2);processImageData(img2,lk.adj);x2.putImageData(img2,0,0);tc.appendChild(cv2);}
            const nm=document.createElement('span'); nm.style.cssText='font-size:13px;color:#fff'; nm.textContent=lk.name;
            s.appendChild(tc); s.appendChild(nm);
            s.addEventListener('click',ev=>{ ev.stopPropagation();const ph2=sel();if(!ph2)return;pushHistory();ph2.adj=structuredClone(lk.adj);syncSliders();drawCurve();renderStage();toast(lk.name); });
            subBox.appendChild(s);
          });
          row.insertAdjacentElement('afterend',subBox);
        });
        box.appendChild(row);
      });
    }
    const allCats=[...new Set(BUILTIN_PRESETS.map(p=>p.cat))];
    const recCats=['Cinematic','Landscape','Nature','Portrait','Film','Light & Mood'];
    makeList(G('presetsRecommended'),recCats.filter(c=>allCats.includes(c)));
    makeList(G('presetsAll'),allCats);
  }

  document.addEventListener('click',e=>{
    const tab=e.target.closest('.preset-tab'); if(!tab)return;
    QA('.preset-tab').forEach(t=>t.classList.remove('on')); tab.classList.add('on');
    const map={recommended:'presetsRecommended',all:'presetsAll',yours:'presetsYours'};
    QA('.preset-list-panel').forEach(p=>p.classList.remove('active'));
    G(map[tab.dataset.ptab])&&G(map[tab.dataset.ptab]).classList.add('active');
  });

  /* ── CROP PANEL ── */
  const arcInner=G('cropArcInner');
  if(arcInner){
    for(let d=-45;d<=45;d++){ const t=document.createElement('div'); t.className='crop-arc-tick'+(d===0?' center-tick':d%5===0?' major':''); arcInner.appendChild(t); }
    let arcDrag=null;
    arcInner.parentElement.addEventListener('pointerdown',e=>{ arcDrag={x:e.clientX,ang:sel()?(sel().adj.angle||0):0}; arcInner.parentElement.setPointerCapture(e.pointerId); },{passive:false});
    arcInner.parentElement.addEventListener('pointermove',e=>{
      if(!arcDrag)return; const p=sel(); if(!p)return;
      p.adj.angle=clamp(Math.round((arcDrag.ang+(e.clientX-arcDrag.x)*0.08)*10)/10,-45,45);
      G('cropArcDeg')&&(G('cropArcDeg').textContent=p.adj.angle.toFixed(2)+'°');
      const ci=G('cropAngle'); if(ci){ci.value=p.adj.angle;G('cropAngleVal').textContent=p.adj.angle.toFixed(1)+'°';}
      scheduleRender(50);
    });
    arcInner.parentElement.addEventListener('pointerup',()=>{ arcDrag=null; });
  }

  document.addEventListener('click',e=>{
    const btn=e.target.closest('.crop-aspect-btn'); if(!btn)return;
    QA('.crop-aspect-btn').forEach(b=>b.classList.remove('on')); btn.classList.add('on');
    G('mobCropAspectLabel')&&(G('mobCropAspectLabel').textContent=btn.lastChild.textContent.trim());
    const maps={'1:1':[1,1],'4:5':[4,5],'16:9':[16,9],'9:16':[9,16],'4:3':[4,3],'3:2':[3,2]};
    if(btn.dataset.ratio==='free'){ cropAspect=null; }
    else if(maps[btn.dataset.ratio]){ cropAspect=maps[btn.dataset.ratio]; applyCropAspect(); }
  });

  document.addEventListener('click',e=>{
    const cc=e.target.closest('.crop-cat'); if(!cc)return;
    QA('.crop-cat').forEach(c=>c.classList.remove('on')); cc.classList.add('on');
  });

  G('mobCropDone')&&G('mobCropDone').addEventListener('click',()=>{ exitCropMode(true); activateMobTool('edit'); });
  G('mobCropCancel')&&G('mobCropCancel').addEventListener('click',()=>{ exitCropMode(false); activateMobTool('edit'); });
  G('mobCropRotateCW')&&G('mobCropRotateCW').addEventListener('click',()=>{ const p=sel();if(!p)return;pushHistory();const c=p.adj.crop||{l:0,t:0,r:1,b:1};p.adj.crop={l:c.t,t:1-c.r,r:c.b,b:1-c.l};renderStage(); });
  G('mobCropFlip')&&G('mobCropFlip').addEventListener('click',()=>{ const p=sel();if(!p)return;p.adj.flipH=!p.adj.flipH;renderStage(); });
  G('mobCropUndo')&&G('mobCropUndo').addEventListener('click',()=>G('undoBtn').click());

  /* ── MASKING PANEL ── */
  document.addEventListener('click',e=>{
    const mt=e.target.closest('.mask-tab'); if(!mt)return;
    QA('.mask-tab').forEach(t=>t.classList.remove('on')); mt.classList.add('on');
    G('maskingRecommended')&&(G('maskingRecommended').style.display=mt.dataset.mt==='recommended'?'':'none');
    G('maskingYours')&&(G('maskingYours').style.display=mt.dataset.mt==='yours'?'':'none');
  });

  document.addEventListener('click',e=>{
    const item=e.target.closest('.adaptive-list-item'); if(!item)return;
    const type=item.dataset.mask;
    QA('.mask-tab').forEach(t=>t.classList.toggle('on',t.dataset.mt==='yours'));
    G('maskingRecommended')&&(G('maskingRecommended').style.display='none');
    G('maskingYours')&&(G('maskingYours').style.display='');
    const m={brush:'addBrush',radial:'addRadial',linear:'addLinear'};
    G(m[type])&&G(m[type]).click();
  });

  G('mobAddBrush')&&G('mobAddBrush').addEventListener('click',()=>G('addBrush').click());
  G('mobAddRadial')&&G('mobAddRadial').addEventListener('click',()=>G('addRadial').click());
  G('mobAddLinear')&&G('mobAddLinear').addEventListener('click',()=>G('addLinear').click());

  /* ── REMOVE PANEL ── */
  const mobSpotSize=G('mobSpotSize');
  mobSpotSize&&mobSpotSize.addEventListener('input',()=>{
    G('mobSpotSizeVal').textContent=mobSpotSize.value;
    const orig=G('spotSize');if(orig){orig.value=mobSpotSize.value;orig.dispatchEvent(new Event('input'));}
  });
  G('mobSpotDone')&&G('mobSpotDone').addEventListener('click',()=>{ if(state.spotMode)toggleSpotMode();activateMobTool('edit'); });

  /* ── HOOK INTO APP ── */
  const _origRenderThumbs=renderThumbs;
  window.renderThumbs=function(){ _origRenderThumbs.apply(this,arguments); if(window.innerWidth<=768)renderLibGrid(); };

  /* ── INITIAL STATE ── */
  renderLibGrid();
  if(sel()){ showEditor(); activateMobTool('edit'); } else { showLibrary(); }

})();
