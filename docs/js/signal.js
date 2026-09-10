// 1-D signal helpers that reproduce the scipy.ndimage / scipy.signal calls the
// extractor was tuned with. tests/test_js_parity.py checks them against scipy.

/** Normalised Gaussian weights, radius = int(truncate * sigma + 0.5) as in scipy. */
export function gaussianKernel(sigma, truncate = 4.0) {
  const radius = Math.floor(truncate * sigma + 0.5);
  const k = new Float64Array(2 * radius + 1);
  let sum = 0;
  for (let i = -radius; i <= radius; i++) sum += (k[i + radius] = Math.exp((-0.5 * i * i) / (sigma * sigma)));
  for (let i = 0; i < k.length; i++) k[i] /= sum;
  return { k, radius };
}

// scipy 'reflect' is half-sample symmetric: d c b a | a b c d | d c b a
export const reflectIndex = (j, n) => { const p = 2 * n; const m = ((j % p) + p) % p; return m < n ? m : p - 1 - m; };
export const wrapIndex = (j, n) => ((j % n) + n) % n;

/** scipy.ndimage.gaussian_filter1d(x, sigma, mode=...) for mode 'reflect' or 'wrap'. */
export function gaussian1d(x, sigma, mode = 'reflect') {
  const n = x.length, { k, radius } = gaussianKernel(sigma);
  const map = mode === 'wrap' ? wrapIndex : reflectIndex;
  const out = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    let s = 0;
    if (i >= radius && i + radius < n) for (let j = 0; j < k.length; j++) s += k[j] * x[i - radius + j];
    else for (let j = 0; j < k.length; j++) s += k[j] * x[map(i - radius + j, n)];
    out[i] = s;
  }
  return out;
}

/** gaussian1d(row)[i] with 'reflect' for one sample, where row = a[offset .. offset + n). */
export function gaussianAtReflect(a, offset, n, i, k, radius) {
  let s = 0;
  if (i >= radius && i + radius < n) for (let j = 0; j < k.length; j++) s += k[j] * a[offset + i - radius + j];
  else for (let j = 0; j < k.length; j++) s += k[j] * a[offset + reflectIndex(i - radius + j, n)];
  return s;
}

function lowerBound(arr, len, v) {
  let lo = 0, hi = len;
  while (lo < hi) { const mid = (lo + hi) >> 1; if (arr[mid] < v) lo = mid + 1; else hi = mid; }
  return lo;
}

/**
 * Sliding rank filter with 'wrap' boundaries, like scipy.ndimage.rank_filter:
 * the window for output i is x[i - size//2 .. i - size//2 + size - 1] and the
 * result is the rank-th smallest value in it.
 */
export function rankFilterWrap(x, size, rank, out = new Float64Array(x.length)) {
  const n = x.length, h = size >> 1;
  const win = new Float64Array(size);
  for (let j = 0; j < size; j++) win[j] = x[wrapIndex(j - h, n)];
  win.sort();
  out[0] = win[rank];
  for (let i = 1; i < n; i++) {
    const gone = x[wrapIndex(i - 1 - h, n)], added = x[wrapIndex(i - h + size - 1, n)];
    const at = lowerBound(win, size, gone);
    win.copyWithin(at, at + 1, size);
    const pos = lowerBound(win, size - 1, added);
    win.copyWithin(pos + 1, pos, size - 1);
    win[pos] = added;
    out[i] = win[rank];
  }
  return out;
}

export const medianFilterWrap = (x, size) => rankFilterWrap(x, size, size >> 1);

/** Rank filter down every column of a rows x cols row-major array (footprint (size, 1), 'wrap'). */
export function rankFilterColumnsWrap(a, rows, cols, size, rank) {
  const out = new Float32Array(rows * cols);
  const col = new Float64Array(rows), res = new Float64Array(rows);
  for (let c = 0; c < cols; c++) {
    for (let r = 0; r < rows; r++) col[r] = a[r * cols + c];
    rankFilterWrap(col, size, rank, res);
    for (let r = 0; r < rows; r++) out[r * cols + c] = res[r];
  }
  return out;
}

export function tile3(x) {
  const n = x.length, out = new Float64Array(3 * n);
  out.set(x, 0); out.set(x, n); out.set(x, 2 * n);
  return out;
}

/**
 * scipy.signal.find_peaks with the subset of options the extractor uses:
 * height (min), prominence (min), distance, width ([min, max]). Returns
 * { peaks, heights } in increasing position order.
 */
export function findPeaks(x, { height = null, prominence = null, distance = null, width = null } = {}) {
  const n = x.length;
  let peaks = [];
  for (let i = 1; i < n - 1; i++) {                          // local maxima; plateaus give their middle
    if (x[i - 1] < x[i]) {
      let ahead = i + 1;
      while (ahead < n - 1 && x[ahead] === x[i]) ahead++;
      if (x[ahead] < x[i]) { peaks.push((i + ahead - 1) >> 1); i = ahead; }
    }
  }
  if (height !== null) peaks = peaks.filter((p) => x[p] >= height);
  if (distance !== null) {
    const d = Math.ceil(distance);
    const order = peaks.map((_, j) => j).sort((a, b) => x[peaks[a]] - x[peaks[b]]);
    const keep = new Uint8Array(peaks.length).fill(1);
    for (let ii = peaks.length - 1; ii >= 0; ii--) {
      const j = order[ii];
      if (!keep[j]) continue;
      for (let k = j - 1; k >= 0 && peaks[j] - peaks[k] < d; k--) keep[k] = 0;
      for (let k = j + 1; k < peaks.length && peaks[k] - peaks[j] < d; k++) keep[k] = 0;
    }
    peaks = peaks.filter((_, j) => keep[j]);
  }
  if (prominence !== null || width !== null) {
    let info = peaks.map((p) => {
      let left = p, leftMin = x[p];
      for (let i = p; i >= 0 && x[i] <= x[p]; i--) if (x[i] < leftMin) { leftMin = x[i]; left = i; }
      let right = p, rightMin = x[p];
      for (let i = p; i < n && x[i] <= x[p]; i++) if (x[i] < rightMin) { rightMin = x[i]; right = i; }
      return { p, prom: x[p] - Math.max(leftMin, rightMin), left, right };
    });
    if (prominence !== null) info = info.filter((o) => o.prom >= prominence);
    if (width !== null) {
      info = info.filter(({ p, prom, left, right }) => {
        const h = x[p] - prom * 0.5;
        let i = p;
        while (left < i && h < x[i]) i--;
        let lip = i;
        if (x[i] < h) lip += (h - x[i]) / (x[i + 1] - x[i]);
        i = p;
        while (i < right && h < x[i]) i++;
        let rip = i;
        if (x[i] < h) rip -= (h - x[i]) / (x[i - 1] - x[i]);
        const w = rip - lip;
        return w >= width[0] && w <= width[1];
      });
    }
    peaks = info.map((o) => o.p);
  }
  return { peaks, heights: peaks.map((p) => x[p]) };
}
