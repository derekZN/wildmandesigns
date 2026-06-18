/* WildmanDesigns — image processing web worker
   Uses importScripts to load engine.js, processes pixel data off the main thread. */
"use strict";
importScripts('./engine.js');

self.onmessage = function(ev) {
  const { buf, w, h, adj, id } = ev.data;
  const img = { data: new Uint8ClampedArray(buf), width: w, height: h };
  processImageData(img, adj);
  self.postMessage({ buf: img.data.buffer, id }, [img.data.buffer]);
};
