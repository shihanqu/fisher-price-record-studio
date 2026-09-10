// Runs the photo scanner off the main thread so the page stays responsive.
import { extractFromRGBA } from './extract.js';

self.onmessage = (e) => {
  const { id, image, opts } = e.data;
  try {
    const res = extractFromRGBA(image, { ...opts, onProgress: (message) => self.postMessage({ id, progress: message }) });
    self.postMessage({ id, result: res }, [res.overlay.data.buffer]);
  } catch (err) {
    self.postMessage({ id, error: (err && err.message) || String(err) });
  }
};
