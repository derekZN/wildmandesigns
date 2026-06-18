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
  const libTitleEl=document.querySelector('.lib-title');
  const LIB_FILTER_LABELS={all:'All photos',picks:'Picks',rejects:'Rejected',rated:'Rated 3+'};

  function setLibFilter(mode){
    state.filterMode=mode;
    if(libTitleEl) libTitleEl.textContent=LIB_FILTER_LABELS[mode]||'All photos';
    QA('#libBottomNav .lib-nav-tab').forEach(t=>t.classList.remove('on'));
    if(mode==='picks') G('libNavGallery')&&G('libNavGallery').classList.add('on');
    else { G('libNavMain')&&G('libNavMain').classList.add('on'); }
    renderLibGrid();
  }

  function renderLibGrid(){
    if(!libGrid) return;
    // Use filtered+sorted photos so the filter state is respected
    const photos=typeof getSortedFilteredPhotos==='function'?getSortedFilteredPhotos():state.photos;
    const hasAny=state.photos.length>0;
    const hasMatch=photos.length>0;
    if(libEmpty){
      libEmpty.style.display=hasAny&&!hasMatch?'':'none';
      if(hasAny&&!hasMatch) libEmpty.innerHTML='<div style="font-size:36px;margin-bottom:16px">🔍</div><div style="font-size:17px;font-weight:700;color:var(--ink);margin-bottom:8px">No '+LIB_FILTER_LABELS[state.filterMode]+'</div><div style="font-size:13px">Try a different filter.</div>';
      else if(!hasAny) libEmpty.innerHTML='<div style="font-size:52px;margin-bottom:20px">📷</div><div style="font-size:20px;font-weight:700;color:var(--ink);margin-bottom:10px">No photos yet</div><div style="font-size:14px;line-height:1.7">Tap + to import photos from your device.</div>';
    }
    QA('#libGrid .year-group').forEach(el=>el.remove());
    if(!photos.length) return;
    const groups={};
    photos.forEach(p=>{ const yr=p.exif&&p.exif.dateTime?p.exif.dateTime.substring(0,4):'Recent'; if(!groups[yr])groups[yr]=[]; groups[yr].push(p); });
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
  G('mobEditBack')&&G('mobEditBack').addEventListener('click',()=>{ if(typeof window._mobZoomReset==='function')window._mobZoomReset(); showLibrary(); renderLibGrid(); });

  /* Hold finger on image 350ms → show original; release → show edited */
  const _mie=G('mobEditImage');
  if(_mie){
    let _ht=null,_wb=false;
    _mie.addEventListener('pointerdown',e=>{
      if(e.pointerType==='touch'&&e.isPrimary){
        _ht=setTimeout(()=>{_ht=null;_wb=true;haptic(8);
          if(typeof before==='function')before(true);else{state.showBefore=true;renderStage();}},350);
      }
    },{passive:true});
    function _rl(){if(_ht){clearTimeout(_ht);_ht=null;}if(_wb){_wb=false;
      if(typeof before==='function')before(false);else{state.showBefore=false;renderStage();}}}
    _mie.addEventListener('pointerup',_rl);_mie.addEventListener('pointercancel',_rl);
  }

  /* Pinch-to-zoom + double-tap-to-zoom on the edit image */
  (function(){
    const c=G('mobEditImage'),mv=G('mobView');if(!c||!mv)return;
    let zoom=1,panX=0,panY=0,pd=0,psz=1;
    function apz(){mv.style.transformOrigin='center center';
      mv.style.transform=zoom>1.01?'scale('+zoom.toFixed(3)+') translate('+panX.toFixed(1)+'px,'+panY.toFixed(1)+'px)':'';
    }
    c.addEventListener('touchstart',e=>{if(e.touches.length===2){pd=Math.hypot(e.touches[0].clientX-e.touches[1].clientX,e.touches[0].clientY-e.touches[1].clientY);psz=zoom;}},{passive:true});
    c.addEventListener('touchmove',e=>{if(e.touches.length===2&&pd>0){const d=Math.hypot(e.touches[0].clientX-e.touches[1].clientX,e.touches[0].clientY-e.touches[1].clientY);zoom=Math.min(6,Math.max(1,psz*(d/pd)));apz();}},{passive:true});
    c.addEventListener('touchend',e=>{if(e.touches.length<2)pd=0;},{passive:true});
    let dbt=null;
    c.addEventListener('touchend',e=>{if(e.changedTouches.length!==1||pd>0)return;
      if(dbt){clearTimeout(dbt);dbt=null;zoom=zoom>1.5?1:2.5;panX=0;panY=0;apz();haptic(6);}
      else dbt=setTimeout(()=>{dbt=null;},300);
    },{passive:true});
    let ps=null;
    c.addEventListener('pointerdown',e=>{if(zoom>1&&e.pointerType==='touch'&&e.isPrimary)ps={x:e.clientX,y:e.clientY,px:panX,py:panY};},{passive:true});
    c.addEventListener('pointermove',e=>{if(!ps||!e.isPrimary)return;panX=ps.px+(e.clientX-ps.x)/zoom;panY=ps.py+(e.clientY-ps.y)/zoom;apz();},{passive:true});
    c.addEventListener('pointerup',()=>{ps=null;});c.addEventListener('pointercancel',()=>{ps=null;});
    window._mobZoomReset=function(){zoom=1;panX=0;panY=0;apz();};
  })();
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
    effects:[{l:'Clarity',k:'clarity',mn:-100,mx:100},{l:'Dehaze',k:'dehaze',mn:-100,mx:100},{l:'Grain',k:'grain',mn:0,mx:100}],
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
      let _prevV=v;
      inp.addEventListener('input',()=>{
        const ph=sel(); if(!ph)return;
        ph.adj[def.k]=def.k==='exposure'?parseFloat(inp.value):parseInt(inp.value);
        const nv=ph.adj[def.k];
        if((_prevV<0&&nv>=0)||(_prevV>0&&nv<=0)) haptic(12);
        _prevV=nv;
        row.querySelector('.val').textContent=def.k==='exposure'?nv.toFixed(2):(nv>0?'+':'')+nv;
        setSliderFill(inp);
        if(typeof renderPreview==='function') renderPreview();
        scheduleRender(80);
      });
      // Double-tap value label to reset to default
      const _vl=row.querySelector('.val'); let _dt=null;
      _vl.addEventListener('touchend',e=>{
        e.preventDefault();
        if(_dt){clearTimeout(_dt);_dt=null;
          const ph=sel();if(!ph)return;
          const dv=typeof DEFAULT_ADJ!=='undefined'?(DEFAULT_ADJ[def.k]||0):0;
          ph.adj[def.k]=dv;inp.value=dv;_prevV=dv;
          _vl.textContent=def.k==='exposure'?dv.toFixed(2):(dv>0?'+':'')+dv;
          setSliderFill(inp);haptic([5,60,5]);
          if(typeof renderPreview==='function')renderPreview();scheduleRender(80);
        } else { _dt=setTimeout(()=>{_dt=null;},320); }
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

  /* ── LIBRARY HEADER: filter, more, nav tabs ── */
  // Gallery tab → toggle picks filter
  G('libNavGallery')&&G('libNavGallery').addEventListener('click',()=>{
    setLibFilter(state.filterMode==='picks'?'all':'picks');
  });
  // Community tab → not yet available
  G('libNavCommunity')&&G('libNavCommunity').addEventListener('click',()=>{
    G('libNavMain')&&G('libNavMain').classList.add('on');
    G('libNavCommunity')&&G('libNavCommunity').classList.remove('on');
    toast('Community features coming in a future update');
  });
  // Filter icon → cycle All → Picks → Rejected → Rated 3+
  G('libFilter')&&G('libFilter').addEventListener('click',()=>{
    const modes=['all','picks','rejects','rated'];
    const next=modes[(modes.indexOf(state.filterMode)+1)%modes.length];
    setLibFilter(next);
    toast(LIB_FILTER_LABELS[next]);
  });
  // More (⋯) → action sheet
  G('libMore')&&G('libMore').addEventListener('click',()=>{
    _showActionSheet([
      {label:'Import Photos',   icon:'⬇', action:()=>G('file').click()},
      {label:'Export All',      icon:'⬆', action:()=>openExport()},
      {label:'Settings',        icon:'⚙', action:()=>G('settingsModal').classList.remove('hide')},
      {label:'Clear All Photos',icon:'🗑', danger:true, action:()=>{
        if(!state.photos.length){toast('No photos to clear');return;}
        if(!confirm('Delete all '+state.photos.length+' photos?'))return;
        deletePhotos(state.photos.map(p=>p.id));
      }},
    ]);
  });

  /* ── MOBILE EDIT HEADER ── */
  // Save (✓) — edits are non-destructive and auto-saved; confirm and return to library
  G('mobEditSave')&&G('mobEditSave').addEventListener('click',()=>{
    if(typeof scheduleSessionSave==='function') scheduleSessionSave();
    toast('Edits saved ✓');
    showLibrary(); renderLibGrid();
  });
  // More (⋯) — edit-level actions
  G('mobEditMore')&&G('mobEditMore').addEventListener('click',()=>{
    const p=sel();
    _showActionSheet([
      {label:'Export photo',   icon:'⬆', action:()=>openExport()},
      {label:'Before / After', icon:'👁', action:()=>{ G('beforeBtn')&&G('beforeBtn').click(); }},
      {label:'Reset all edits',icon:'↺', action:()=>{ G('resetEdit')&&G('resetEdit').click(); toast('Edits reset'); }},
      {label:'Delete photo',   icon:'🗑', danger:true, action:()=>{
        if(!p)return;
        if(!confirm('Delete "'+p.name+'"?'))return;
        deletePhotos([p.id]); showLibrary(); renderLibGrid();
      }},
    ]);
  });

  /* ── CROP LOCK ── */
  let _cropLocked=false;
  G('mobCropLock')&&G('mobCropLock').addEventListener('click',()=>{
    const p=sel(); if(!p)return;
    _cropLocked=!_cropLocked;
    const btn=G('mobCropLock');
    if(_cropLocked){
      const c=p.adj.crop||{l:0,t:0,r:1,b:1};
      const rb=typeof rotatedBounds==='function'?rotatedBounds(p):{rotW:p.w,rotH:p.h};
      const cw=(c.r-c.l)*rb.rotW, ch=(c.b-c.t)*rb.rotH;
      if(cw>0&&ch>0) cropAspect=[cw,ch];
      if(btn) btn.style.color='var(--amber)';
      toast('Aspect ratio locked');
    } else {
      cropAspect=null;
      if(btn) btn.style.color='';
      toast('Aspect ratio free');
    }
  });

  /* ── ACTIONS: SUBJECT & BACKGROUND ── */
  // Subject → add a radial mask centred on the image; user fine-tunes from there
  G('actSubject')&&G('actSubject').addEventListener('click',()=>{
    const p=sel(); if(!p){toast('Select a photo first');return;}
    pushHistory();
    if(!p.masks) p.masks=[];
    p.masks.push({id:Date.now(),type:'radial',cx:0.5,cy:0.5,rx:0.28,ry:0.35,
                  adj:{exposure:0,contrast:0,saturation:0,temp:0},feather:60,inverted:false});
    state.activeMask=p.masks.length-1;
    activateMobTool('masking');
    QA('.mask-tab').forEach(t=>t.classList.toggle('on',t.dataset.mt==='yours'));
    G('maskingRecommended')&&(G('maskingRecommended').style.display='none');
    G('maskingYours')&&(G('maskingYours').style.display='');
    renderStage();
    toast('Subject mask added — adjust in Masking');
  });
  // Background → same but inverted (affects area outside the radial)
  G('actBackground')&&G('actBackground').addEventListener('click',()=>{
    const p=sel(); if(!p){toast('Select a photo first');return;}
    pushHistory();
    if(!p.masks) p.masks=[];
    p.masks.push({id:Date.now(),type:'radial',cx:0.5,cy:0.5,rx:0.28,ry:0.35,
                  adj:{exposure:0,contrast:0,saturation:0,temp:0},feather:60,inverted:true});
    state.activeMask=p.masks.length-1;
    activateMobTool('masking');
    QA('.mask-tab').forEach(t=>t.classList.toggle('on',t.dataset.mt==='yours'));
    G('maskingRecommended')&&(G('maskingRecommended').style.display='none');
    G('maskingYours')&&(G('maskingYours').style.display='');
    renderStage();
    toast('Background mask added — adjust in Masking');
  });

  /* ── ACTION SHEET (reusable slide-up menu) ── */
  function _showActionSheet(items){
    const old=document.querySelector('.mob-action-sheet-wrap'); if(old)old.remove();
    const wrap=document.createElement('div');
    wrap.className='mob-action-sheet-wrap';
    wrap.style.cssText='position:fixed;inset:0;z-index:400;background:rgba(0,0,0,.45)';
    const sheet=document.createElement('div');
    sheet.style.cssText='position:absolute;bottom:0;left:0;right:0;background:#1c1f26;border-radius:18px 18px 0 0;padding:8px 0 calc(20px + env(safe-area-inset-bottom))';
    const pill=document.createElement('div');
    pill.style.cssText='width:36px;height:4px;background:rgba(255,255,255,.18);border-radius:2px;margin:10px auto 12px';
    sheet.appendChild(pill);
    items.forEach(item=>{
      const btn=document.createElement('button');
      btn.style.cssText='display:flex;align-items:center;gap:16px;width:100%;padding:15px 22px;border:0;background:transparent;color:'+(item.danger?'#e5687a':'#e7e9ed')+';font-size:16px;font-family:inherit;cursor:pointer;text-align:left;-webkit-tap-highlight-color:transparent';
      btn.innerHTML='<span style="font-size:22px;width:30px;text-align:center">'+item.icon+'</span><span>'+item.label+'</span>';
      btn.addEventListener('click',()=>{ wrap.remove(); item.action(); });
      btn.addEventListener('touchstart',()=>btn.style.background='rgba(255,255,255,.06)',{passive:true});
      btn.addEventListener('touchend',()=>btn.style.background='',{passive:true});
      sheet.appendChild(btn);
    });
    wrap.appendChild(sheet);
    wrap.addEventListener('click',e=>{ if(e.target===wrap)wrap.remove(); });
    document.body.appendChild(wrap);
    sheet.style.transform='translateY(100%)';
    requestAnimationFrame(()=>{ sheet.style.transition='transform .22s ease'; sheet.style.transform=''; });
  }

  /* ── HOOK INTO APP ── */
  const _origRenderThumbs=renderThumbs;
  window.renderThumbs=function(){ _origRenderThumbs.apply(this,arguments); if(window.innerWidth<=768)renderLibGrid(); };

  /* ── INITIAL STATE ── */
  renderLibGrid();
  if(sel()){ showEditor(); activateMobTool('edit'); } else { showLibrary(); }

})();
