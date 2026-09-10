// Main-thread side of the scanner: decode the uploaded photo, shrink it to a
// sensible working size and hand it to the worker.

// Detection is unchanged down to ~1600 px on the long side (checked on the
// reference photo), so big phone photos are scaled down for speed and memory.
export const MAX_SIDE = 3000;

async function decode(blob) {
  try { return await createImageBitmap(blob, { imageOrientation: 'from-image' }); } catch (e) { /* older browsers */ }
  try { return await createImageBitmap(blob); } catch (e) { /* fall through */ }
  const url = URL.createObjectURL(blob);
  try {
    const img = new Image();
    img.src = url;
    await img.decode();
    return img;
  } finally {
    URL.revokeObjectURL(url);
  }
}

/** RGBA pixels of an image file, scaled so the long side is at most maxSide. */
export async function loadImageData(blob, maxSide = MAX_SIDE) {
  const src = await decode(blob);
  const sw = src.width || src.naturalWidth, sh = src.height || src.naturalHeight;
  if (!sw || !sh) throw new Error("That file doesn't look like an image.");
  const s = Math.min(1, maxSide / Math.max(sw, sh));
  const w = Math.max(1, Math.round(sw * s)), h = Math.max(1, Math.round(sh * s));
  const canvas = typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(w, h) : Object.assign(document.createElement('canvas'), { width: w, height: h });
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(src, 0, 0, w, h);
  if (src.close) src.close();
  const { data } = ctx.getImageData(0, 0, w, h);
  return { data, width: w, height: h, originalWidth: sw, originalHeight: sh };
}

let worker = null, seq = 0;
const pending = new Map();

function getWorker() {
  if (!worker) {
    worker = new Worker(new URL('./extract-worker.js', import.meta.url), { type: 'module' });
    worker.onmessage = ({ data }) => {
      const job = pending.get(data.id);
      if (!job) return;
      if (data.progress) { job.onProgress(data.progress); return; }
      pending.delete(data.id);
      if (data.error) job.reject(new Error(data.error)); else job.resolve(data.result);
    };
    worker.onerror = (e) => {
      for (const job of pending.values()) job.reject(new Error(e.message || 'the scanner stopped unexpectedly'));
      pending.clear();
      worker = null;
    };
  }
  return worker;
}

/** Scan already-decoded pixels in the worker. */
export function scanImageData(image, opts = {}, onProgress = () => {}) {
  return new Promise((resolve, reject) => {
    const id = ++seq;
    pending.set(id, { resolve, reject, onProgress });
    getWorker().postMessage({ id, image, opts }, [image.data.buffer]);
  });
}

/** Decode, shrink and scan an image file. */
export async function scanFile(file, opts = {}, onProgress = () => {}) {
  onProgress('Opening the photo');
  const img = await loadImageData(file);
  const image = { data: img.data, width: img.width, height: img.height };
  const res = await scanImageData(image, { sourceName: file.name || '', ...opts }, onProgress);
  res.input = { width: img.width, height: img.height, originalWidth: img.originalWidth, originalHeight: img.originalHeight };
  return res;
}
