"use strict";
/* WildmanDesigns — PWA polish: haptics, wake lock, install prompt, offline */
/* ============================================================
   PWA POLISH — haptics · wake lock · install prompt · offline · draggable sheet
   ============================================================ */

// Haptic helper — called from multiple places above
function haptic(pat=8){ if(navigator.vibrate) navigator.vibrate(pat); }

// Screen Wake Lock — keep screen on while editing
let _wakeLock=null;
async function _requestWakeLock(){
  if(!('wakeLock' in navigator)||document.visibilityState!=='visible') return;
  try{ _wakeLock=await navigator.wakeLock.request('screen'); _wakeLock.addEventListener('release',()=>{_wakeLock=null;}); }catch(e){}
}
document.addEventListener('visibilitychange',()=>{
  if(document.visibilityState==='visible'&&!_wakeLock&&state.photos.length) _requestWakeLock();
});

// Install prompt — shows "Install" button when browser fires beforeinstallprompt
let _deferredPrompt=null;
const _installBtn=$('#installBtn');
window.addEventListener('beforeinstallprompt',e=>{
  e.preventDefault(); _deferredPrompt=e;
  if(_installBtn) _installBtn.classList.remove('hide');
});
if(_installBtn) _installBtn.addEventListener('click',async()=>{
  if(!_deferredPrompt) return;
  _deferredPrompt.prompt();
  const {outcome}=await _deferredPrompt.userChoice;
  _deferredPrompt=null;
  _installBtn.classList.add('hide');
});
window.addEventListener('appinstalled',()=>{
  if(_installBtn) _installBtn.classList.add('hide');
  _deferredPrompt=null;
  toast('Installed! Open from your home screen.');
});

// Offline indicator
const _offlineDot=$('#offlineDot');
function _updateOnlineStatus(){
  if(_offlineDot) _offlineDot.classList.toggle('hide',navigator.onLine);
}
window.addEventListener('online',_updateOnlineStatus);
window.addEventListener('offline',()=>{ _updateOnlineStatus(); toast('Working offline — all edits save locally'); });
_updateOnlineStatus();

// Draggable bottom sheet — drag the handle to resize, snap to positions
(function(){
  const handle=document.querySelector('.sheet-handle');
  const sheet=document.querySelector('.col.right');
  const stageEl=$('#stage');
  if(!handle||!sheet) return;
  let drag=null;
  handle.addEventListener('pointerdown',e=>{
    if(window.innerWidth>768) return;
    drag={y:e.clientY, h:sheet.getBoundingClientRect().height};
    handle.setPointerCapture(e.pointerId);
    sheet.style.transition='none';
    e.preventDefault();
  },{passive:false});
  handle.addEventListener('pointermove',e=>{
    if(!drag) return;
    const dy=drag.y-e.clientY;
    const newH=Math.max(80,Math.min(window.innerHeight*0.92,drag.h+dy));
    sheet.style.height=newH+'px';
    if(stageEl) stageEl.style.paddingBottom=newH+'px';
  });
  function snapSheet(){
    if(!drag) return;
    sheet.style.transition='';
    const h=sheet.getBoundingClientRect().height;
    const vh=window.innerHeight;
    if(h<vh*0.18){ mobTab('view'); sheet.style.height=''; if(stageEl) stageEl.style.paddingBottom=''; }
    else if(h>vh*0.65){ sheet.style.height='88vh'; if(stageEl) stageEl.style.paddingBottom='88vh'; }
    else { sheet.style.height='42vh'; if(stageEl) stageEl.style.paddingBottom='42vh'; }
    drag=null;
  }
  handle.addEventListener('pointerup',snapSheet);
  handle.addEventListener('pointercancel',()=>{ drag=null; sheet.style.transition=''; });
})();

// Request wake lock when photos are first loaded
const _origAddFiles=addFiles;
// Wire wake lock after first import (addFiles is already defined above)
document.addEventListener('DOMContentLoaded',()=>{}, {once:true});
// Actually just request it once on any photo selection
const _origOnPhotoChanged=onPhotoChanged;
// Simpler: request wake lock when editing starts (first render with a photo)
(function(){
  let wlRequested=false;
  const origRender=renderStage;
  window._wlHook=function(){
    if(!wlRequested&&sel()){ wlRequested=true; _requestWakeLock(); }
    origRender.apply(this,arguments);
  };
})();

/* ============================================================
   MOBILE LIGHTROOM-STYLE UI
   Only active on screens ≤ 768px.
   ============================================================ */
