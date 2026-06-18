"use strict";
/* WildmanDesigns — IndexedDB persistence layer */
const IDB_NAME='wildman-db', IDB_VERSION=1;
let _idbPromise=null;
function idbOpen(){
  if(_idbPromise) return _idbPromise;
  _idbPromise=new Promise((resolve,reject)=>{
    const req=indexedDB.open(IDB_NAME,IDB_VERSION);
    req.onupgradeneeded=()=>{
      const db=req.result;
      if(!db.objectStoreNames.contains('files')) db.createObjectStore('files',{keyPath:'id'});
      if(!db.objectStoreNames.contains('edits')) db.createObjectStore('edits',{keyPath:'id'});
      if(!db.objectStoreNames.contains('meta'))  db.createObjectStore('meta',{keyPath:'key'});
    };
    req.onsuccess=()=>resolve(req.result);
    req.onerror=()=>reject(req.error);
  });
  return _idbPromise;
}
function idbPut(store,value){
  return idbOpen().then(db=>new Promise((resolve,reject)=>{
    const tx=db.transaction(store,'readwrite');
    tx.objectStore(store).put(value);
    tx.oncomplete=()=>resolve(); tx.onerror=()=>reject(tx.error);
  })).catch(err=>console.warn('idbPut failed',store,err));
}
function idbGetAll(store){
  return idbOpen().then(db=>new Promise((resolve,reject)=>{
    const req=db.transaction(store,'readonly').objectStore(store).getAll();
    req.onsuccess=()=>resolve(req.result); req.onerror=()=>reject(req.error);
  })).catch(err=>{ console.warn('idbGetAll failed',store,err); return []; });
}
function idbGet(store,key){
  return idbOpen().then(db=>new Promise((resolve,reject)=>{
    const req=db.transaction(store,'readonly').objectStore(store).get(key);
    req.onsuccess=()=>resolve(req.result); req.onerror=()=>reject(req.error);
  })).catch(()=>undefined);
}
function idbDelete(store,key){
  return idbOpen().then(db=>new Promise((resolve,reject)=>{
    const tx=db.transaction(store,'readwrite');
    tx.objectStore(store).delete(key);
    tx.oncomplete=()=>resolve(); tx.onerror=()=>reject(tx.error);
  })).catch(err=>console.warn('idbDelete failed',store,err));
}

async function saveSessionIDB(){
  if(!state.photos.length)return;
  for(const p of state.photos){
    await idbPut('edits',{ id:p.id, adj:p.adj, masks:p.masks, spots:p.spots||[], rating:p.rating||0, flag:p.flag||0, exif:p.exif||{}, collections:[...(p.collections||[])] });
  }
  await idbPut('meta',{ key:'app', selId:state.selId, order:state.photos.map(p=>p.id), presets:state.presets });
}

async function restoreSessionIDB(){
  const files=await idbGetAll('files');
  if(!files.length)return;
  busy(true,'Restoring last session…');
  const edits=await idbGetAll('edits');
  const editsById=new Map(edits.map(e=>[e.id,e]));
  const meta=await idbGet('meta','app');
  const byId=new Map(files.map(f=>[f.id,f]));
  const order=(meta&&meta.order&&meta.order.length)?meta.order:files.map(f=>f.id);

  for(const id of order){
    const file=byId.get(id); if(!file)continue;
    try{
      const isRaw=isRawFile({name:file.name});
      const bmp=isRaw ? await loadRawBitmap(file.blob) : await createImageBitmap(file.blob,{imageOrientation:'from-image'});
      const e=editsById.get(id)||{};
      const p={ id:file.id, name:file.name, bitmap:bmp, w:bmp.width, h:bmp.height,
        adj: e.adj ? normalizeAdj(structuredClone(e.adj)) : structuredClone(DEFAULT_ADJ),
        masks: e.masks || [], spots: e.spots || [],
        thumb:document.createElement('canvas'), _undo:[], _redo:[],
        rating: e.rating||0, flag: e.flag||0, exif: e.exif||{}, collections: new Set(e.collections||[]) };
      makeThumb(p);
      state.photos.push(p);
      uid=Math.max(uid,p.id+1);
      p.masks.forEach(m=>{ if(m.id>=maskUid)maskUid=m.id+1; });
      p.spots.forEach(s=>{ if(s.id>=spotUid)spotUid=s.id+1; });
    }catch(err){ console.warn('session restore decode failed',file.name,err); }
    await wait(0);
  }

  if(meta){
    if(meta.presets) state.presets=meta.presets;
    state.selId = state.photos.find(p=>p.id===meta.selId) ? meta.selId : (state.photos[0]&&state.photos[0].id);
  } else if(state.photos.length){
    state.selId=state.photos[0].id;
  }

  busy(false);
  if(state.photos.length){
    renderThumbs(); renderStage(); renderLooks(); renderPresets(); updateChrome();
    syncSliders(); drawCurve(); renderMasks();
    toast('Restored '+state.photos.length+' photo'+(state.photos.length>1?'s':''));
  }
}

