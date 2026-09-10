// Image-processing primitives for the scanner. Plain typed arrays, no
// dependencies. Images are row-major; masks are Uint8Array holding 0 or 1.
// Where it matters the behaviour follows the OpenCV calls in fpmb/extract.py.

// ------------------------------------------------------------------ colour

/** Hue on OpenCV's 8-bit scale (0..179) plus a "strongly coloured" flag (S > 60 and V > 40). */
export function hueAndSat(rgba, n) {
  const H = new Uint8Array(n), sat = new Uint8Array(n);
  for (let p = 0, j = 0; p < n; p++, j += 4) {
    const r = rgba[j], g = rgba[j + 1], b = rgba[j + 2];
    const v = Math.max(r, g, b), diff = v - Math.min(r, g, b);
    if (diff === 0) continue;
    if (Math.round((255 * diff) / v) > 60 && v > 40) sat[p] = 1;
    let h = v === r ? g - b : v === g ? b - r + 2 * diff : r - g + 4 * diff;
    h = Math.round((h * 30) / diff);
    H[p] = h < 0 ? h + 180 : h;
  }
  return { H, sat };
}

/** OpenCV's RGB -> gray: (R*4899 + G*9617 + B*1868 + 8192) >> 14. */
export function rgbaToGray(rgba, n) {
  const g = new Float32Array(n);
  for (let p = 0, j = 0; p < n; p++, j += 4) g[p] = (rgba[j] * 4899 + rgba[j + 1] * 9617 + rgba[j + 2] * 1868 + 8192) >> 14;
  return g;
}

// ------------------------------------------------------------------ binary morphology

// Square k x k kernel (k odd). Like OpenCV, pixels outside the image are
// ignored: erosion never eats in from the border and dilation never grows from it.
function morphPass(src, dst, w, h, r, horizontal, erode) {
  const target = erode ? 0 : 1;
  const [len, lines, step, lineStep] = horizontal ? [w, h, 1, w] : [h, w, w, 1];
  for (let l = 0; l < lines; l++) {
    const base = l * lineStep;
    let cnt = 0;
    for (let i = 0; i <= Math.min(r, len - 1); i++) if (src[base + i * step] === target) cnt++;
    for (let i = 0; i < len; i++) {
      dst[base + i * step] = erode ? (cnt === 0 ? 1 : 0) : (cnt > 0 ? 1 : 0);
      const add = i + r + 1, rem = i - r;
      if (add < len && src[base + add * step] === target) cnt++;
      if (rem >= 0 && src[base + rem * step] === target) cnt--;
    }
  }
}

function morph(mask, w, h, k, erode) {
  const tmp = new Uint8Array(w * h), out = new Uint8Array(w * h);
  morphPass(mask, tmp, w, h, k >> 1, true, erode);
  morphPass(tmp, out, w, h, k >> 1, false, erode);
  return out;
}

export const erode = (m, w, h, k) => morph(m, w, h, k, true);
export const dilate = (m, w, h, k) => morph(m, w, h, k, false);
export const open = (m, w, h, k) => dilate(erode(m, w, h, k), w, h, k);
export const close = (m, w, h, k) => erode(dilate(m, w, h, k), w, h, k);

// ------------------------------------------------------------------ connected components

/** 8-connected components, labelled in raster order, with area, bounding box and centroid. */
export function components(mask, w, h) {
  const labels = new Int32Array(w * h);
  const stack = new Int32Array(w * h);
  const stats = [];
  for (let start = 0; start < w * h; start++) {
    if (!mask[start] || labels[start]) continue;
    const id = stats.length + 1;
    let sp = 0, area = 0, sx = 0, sy = 0, x0 = w, y0 = h, x1 = -1, y1 = -1;
    stack[sp++] = start; labels[start] = id;
    while (sp) {
      const q = stack[--sp], x = q % w, y = (q - x) / w;
      area++; sx += x; sy += y;
      if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
      for (let dy = -1; dy <= 1; dy++) {
        const yy = y + dy;
        if (yy < 0 || yy >= h) continue;
        for (let dx = -1; dx <= 1; dx++) {
          const xx = x + dx;
          if (xx < 0 || xx >= w) continue;
          const nb = yy * w + xx;
          if (mask[nb] && !labels[nb]) { labels[nb] = id; stack[sp++] = nb; }
        }
      }
    }
    stats.push({ id, area, cx: sx / area, cy: sy / area, x0, y0, x1, y1, bw: x1 - x0 + 1, bh: y1 - y0 + 1 });
  }
  return { labels, stats };
}

/** The largest 8-connected component as its own mask, with its stats; null if the mask is empty. */
export function largestComponent(mask, w, h) {
  const { labels, stats } = components(mask, w, h);
  if (!stats.length) return null;
  let best = stats[0];
  for (const s of stats) if (s.area > best.area) best = s;
  const out = new Uint8Array(w * h);
  for (let p = 0; p < w * h; p++) if (labels[p] === best.id) out[p] = 1;
  return { mask: out, ...best };
}

/** Fill the holes of a mask: everything the outside (4-connected) cannot reach. */
export function fillHoles(mask, w, h) {
  const outside = new Uint8Array(w * h), stack = new Int32Array(w * h);
  let sp = 0;
  const push = (p) => { if (!mask[p] && !outside[p]) { outside[p] = 1; stack[sp++] = p; } };
  for (let x = 0; x < w; x++) { push(x); push((h - 1) * w + x); }
  for (let y = 0; y < h; y++) { push(y * w); push(y * w + w - 1); }
  while (sp) {
    const q = stack[--sp], x = q % w;
    if (x > 0) push(q - 1);
    if (x < w - 1) push(q + 1);
    if (q >= w) push(q - w);
    if (q < w * (h - 1)) push(q + w);
  }
  const out = new Uint8Array(w * h);
  for (let p = 0; p < w * h; p++) out[p] = outside[p] ? 0 : 1;
  return out;
}

// ------------------------------------------------------------------ geometry

/** Convex hull (monotone chain), collinear points dropped. */
export function convexHull(points) {
  const pts = points.slice().sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  if (pts.length < 3) return pts;
  const cross = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lower = [], upper = [];
  for (const p of pts) { while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) lower.pop(); lower.push(p); }
  for (let i = pts.length - 1; i >= 0; i--) { const p = pts[i]; while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) upper.pop(); upper.push(p); }
  lower.pop(); upper.pop();
  return lower.concat(upper);
}

/** Hull of a component, from the leftmost and rightmost pixel of each row. */
export function hullOfMask(comp, w) {
  const pts = [];
  for (let y = comp.y0; y <= comp.y1; y++) {
    let first = -1, last = -1;
    for (let x = comp.x0; x <= comp.x1; x++) if (comp.mask[y * w + x]) { if (first < 0) first = x; last = x; }
    if (first >= 0) { pts.push([first, y]); if (last !== first) pts.push([last, y]); }
  }
  return convexHull(pts);
}

/** Solve A x = b (Gaussian elimination, partial pivoting). Returns null when singular. */
export function solve(A, b) {
  const n = b.length, M = A.map((row, i) => [...row, b[i]]);
  for (let c = 0; c < n; c++) {
    let piv = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[piv][c])) piv = r;
    if (Math.abs(M[piv][c]) < 1e-300) return null;
    [M[c], M[piv]] = [M[piv], M[c]];
    for (let r = c + 1; r < n; r++) {
      const f = M[r][c] / M[c][c];
      if (f) for (let k = c; k <= n; k++) M[r][k] -= f * M[c][k];
    }
  }
  const x = new Array(n).fill(0);
  for (let r = n - 1; r >= 0; r--) {
    let s = M[r][n];
    for (let k = r + 1; k < n; k++) s -= M[r][k] * x[k];
    x[r] = s / M[r][r];
  }
  return x;
}

/** Least squares via the normal equations (the systems here are small and well scaled). */
export function lstsq(rows, rhs) {
  const k = rows[0].length;
  const AtA = Array.from({ length: k }, () => new Array(k).fill(0)), Atb = new Array(k).fill(0);
  rows.forEach((row, i) => {
    for (let a = 0; a < k; a++) {
      Atb[a] += row[a] * rhs[i];
      for (let b = a; b < k; b++) AtA[a][b] += row[a] * row[b];
    }
  });
  for (let a = 0; a < k; a++) for (let b = 0; b < a; b++) AtA[a][b] = AtA[b][a];
  return solve(AtA, Atb);
}

/**
 * Ellipse through a set of points, using the same two-stage algebraic fit as
 * OpenCV's fitEllipse. Returns centre (cx, cy), the semi-axis `a` along
 * direction `theta` (radians, image coordinates) and the semi-axis `b` across it.
 */
export function fitEllipse(points) {
  const n = points.length;
  if (n < 5) throw new Error('not enough outline points to fit the disc');
  let mx = 0, my = 0;
  for (const [x, y] of points) { mx += x; my += y; }
  mx /= n; my /= n;
  let s = 0;
  for (const [x, y] of points) s += Math.abs(x - mx) + Math.abs(y - my);
  const scale = 100 / Math.max(s, 1.1920929e-7);
  const P = points.map(([x, y]) => [(x - mx) * scale, (y - my) * scale]);
  const g = lstsq(P.map(([x, y]) => [-x * x, -y * y, -x * y, x, y]), P.map(() => 10000));
  const c = solve([[2 * g[0], g[2]], [g[2], 2 * g[1]]], [g[3], g[4]]);
  const q = lstsq(P.map(([x, y]) => { const u = x - c[0], v = y - c[1]; return [u * u, v * v, u * v]; }), P.map(() => 1));
  const A = q[0], B = q[1], C = q[2] / 2;
  const mean = (A + B) / 2, dev = Math.hypot((A - B) / 2, C);
  const theta = 0.5 * Math.atan2(2 * C, A - B);                   // axis of the larger eigenvalue
  return { cx: mx + c[0] / scale, cy: my + c[1] / scale, a: 1 / Math.sqrt(Math.abs(mean + dev)) / scale, b: 1 / Math.sqrt(Math.abs(mean - dev)) / scale, theta };
}

// ------------------------------------------------------------------ 3x3 matrices and homographies

export const eye3 = () => [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
export const mul3 = (A, B) => A.map((r) => [0, 1, 2].map((j) => r[0] * B[0][j] + r[1] * B[1][j] + r[2] * B[2][j]));
export function inv3(m) {
  const [[a, b, c], [d, e, f], [g, h, i]] = m;
  const A = e * i - f * h, B = -(d * i - f * g), C = d * h - e * g;
  const det = a * A + b * B + c * C;
  return [[A / det, -(b * i - c * h) / det, (b * f - c * e) / det],
          [B / det, (a * i - c * g) / det, -(a * f - c * d) / det],
          [C / det, -(a * h - b * g) / det, (a * e - b * d) / det]];
}
export function apply3(M, [x, y]) {
  const w = M[2][0] * x + M[2][1] * y + M[2][2];
  return [(M[0][0] * x + M[0][1] * y + M[0][2]) / w, (M[1][0] * x + M[1][1] * y + M[1][2]) / w];
}

function isoNormalisation(pts) {
  let mx = 0, my = 0;
  for (const [x, y] of pts) { mx += x; my += y; }
  mx /= pts.length; my /= pts.length;
  let d = 0;
  for (const [x, y] of pts) d += Math.hypot(x - mx, y - my);
  d /= pts.length;
  const s = d > 0 ? Math.SQRT2 / d : 1;
  return [[s, 0, -s * mx], [0, s, -s * my], [0, 0, 1]];
}

/**
 * Least-squares homography mapping src to dst: a normalised linear fit
 * polished with Levenberg-Marquardt on the reprojection error (as
 * cv2.findHomography does with method 0). Returns null if degenerate.
 */
export function findHomography(src, dst) {
  if (src.length < 4) return null;
  const Ts = isoNormalisation(src), Td = isoNormalisation(dst);
  const S = src.map((p) => apply3(Ts, p)), D = dst.map((p) => apply3(Td, p));
  const rows = [], rhs = [];
  S.forEach(([X, Y], i) => {
    const [x, y] = D[i];
    rows.push([X, Y, 1, 0, 0, 0, -x * X, -x * Y]); rhs.push(x);
    rows.push([0, 0, 0, X, Y, 1, -y * X, -y * Y]); rhs.push(y);
  });
  let h = lstsq(rows, rhs);
  if (!h) return null;
  const cost = (hh) => {
    let c = 0;
    S.forEach(([X, Y], i) => {
      const w = hh[6] * X + hh[7] * Y + 1;
      const u = (hh[0] * X + hh[1] * Y + hh[2]) / w - D[i][0], v = (hh[3] * X + hh[4] * Y + hh[5]) / w - D[i][1];
      c += u * u + v * v;
    });
    return c;
  };
  let c0 = cost(h), lambda = 1e-3;
  for (let it = 0; it < 20; it++) {
    const JtJ = Array.from({ length: 8 }, () => new Array(8).fill(0)), Jtr = new Array(8).fill(0);
    S.forEach(([X, Y], i) => {
      const w = h[6] * X + h[7] * Y + 1;
      const u = (h[0] * X + h[1] * Y + h[2]) / w, v = (h[3] * X + h[4] * Y + h[5]) / w;
      const ju = [X / w, Y / w, 1 / w, 0, 0, 0, (-u * X) / w, (-u * Y) / w];
      const jv = [0, 0, 0, X / w, Y / w, 1 / w, (-v * X) / w, (-v * Y) / w];
      const ru = u - D[i][0], rv = v - D[i][1];
      for (let a = 0; a < 8; a++) {
        Jtr[a] += ju[a] * ru + jv[a] * rv;
        for (let b = 0; b < 8; b++) JtJ[a][b] += ju[a] * ju[b] + jv[a] * jv[b];
      }
    });
    let stepped = false, gain = 0;
    for (let tries = 0; tries < 12 && !stepped; tries++) {
      const M = JtJ.map((row, a) => row.map((v, b) => (a === b ? v * (1 + lambda) : v)));
      const delta = solve(M, Jtr.map((v) => -v));
      if (delta) {
        const h2 = h.map((v, j) => v + delta[j]), c2 = cost(h2);
        if (c2 < c0) { gain = (c0 - c2) / Math.max(c0, 1e-300); h = h2; c0 = c2; lambda = Math.max(lambda / 10, 1e-12); stepped = true; continue; }
      }
      lambda *= 10;
    }
    if (!stepped || gain < 1e-12) break;
  }
  const H = mul3(inv3(Td), mul3([[h[0], h[1], h[2]], [h[3], h[4], h[5]], [h[6], h[7], 1]], Ts));
  const k = H[2][2];
  return H.map((r) => r.map((v) => v / k));
}

// ------------------------------------------------------------------ warping and sampling
// `inv` maps an output pixel (x, y) back to source coordinates.

/** Bilinear warp of a single-channel float image; taps outside the source read 0. */
export function warpGray(src, sw, sh, inv, ow, oh) {
  const out = new Float32Array(ow * oh);
  const [[a, b, c], [d, e, f], [g, h, i]] = inv;
  for (let y = 0; y < oh; y++) {
    for (let x = 0; x < ow; x++) {
      const w = g * x + h * y + i;
      const sx = (a * x + b * y + c) / w, sy = (d * x + e * y + f) / w;
      const x0 = Math.floor(sx), y0 = Math.floor(sy), fx = sx - x0, fy = sy - y0;
      if (x0 >= 0 && y0 >= 0 && x0 + 1 < sw && y0 + 1 < sh) {
        const p = y0 * sw + x0;
        out[y * ow + x] = (src[p] * (1 - fx) + src[p + 1] * fx) * (1 - fy) + (src[p + sw] * (1 - fx) + src[p + sw + 1] * fx) * fy;
      } else if (x0 >= -1 && y0 >= -1 && x0 < sw && y0 < sh) {
        const at = (xx, yy) => (xx >= 0 && yy >= 0 && xx < sw && yy < sh ? src[yy * sw + xx] : 0);
        out[y * ow + x] = (at(x0, y0) * (1 - fx) + at(x0 + 1, y0) * fx) * (1 - fy) + (at(x0, y0 + 1) * (1 - fx) + at(x0 + 1, y0 + 1) * fx) * fy;
      }
    }
  }
  return out;
}

/** Nearest-neighbour warp of a mask; outside the source is 0. */
export function warpMaskNearest(src, sw, sh, inv, ow, oh) {
  const out = new Uint8Array(ow * oh);
  const [[a, b, c], [d, e, f], [g, h, i]] = inv;
  for (let y = 0; y < oh; y++) {
    for (let x = 0; x < ow; x++) {
      const w = g * x + h * y + i;
      const sx = Math.round((a * x + b * y + c) / w), sy = Math.round((d * x + e * y + f) / w);
      if (sx >= 0 && sy >= 0 && sx < sw && sy < sh) out[y * ow + x] = src[sy * sw + sx];
    }
  }
  return out;
}

/** Bilinear warp of an RGBA image (for the on-screen overlay); outside is a neutral grey. */
export function warpRGBA(src, sw, sh, inv, ow, oh) {
  const out = new Uint8ClampedArray(ow * oh * 4);
  const [[a, b, c], [d, e, f], [g, h, i]] = inv;
  for (let y = 0; y < oh; y++) {
    for (let x = 0; x < ow; x++) {
      const w = g * x + h * y + i;
      const sx = Math.min(Math.max((a * x + b * y + c) / w, 0), sw - 1.001), sy = Math.min(Math.max((d * x + e * y + f) / w, 0), sh - 1.001);
      const x0 = Math.floor(sx), y0 = Math.floor(sy), fx = sx - x0, fy = sy - y0;
      const p = (y0 * sw + x0) * 4, o = (y * ow + x) * 4;
      for (let ch = 0; ch < 3; ch++) {
        out[o + ch] = (src[p + ch] * (1 - fx) + src[p + 4 + ch] * fx) * (1 - fy) + (src[p + sw * 4 + ch] * (1 - fx) + src[p + sw * 4 + 4 + ch] * fx) * fy;
      }
      out[o + 3] = 255;
    }
  }
  return out;
}

// OpenCV's default border for blurs, BORDER_REFLECT_101: gfedcb|abcdefgh|gfedcba
const reflect101 = (j, n) => { if (n === 1) return 0; const p = 2 * n - 2; const m = ((j % p) + p) % p; return m < n ? m : p - m; };

function boxSizes(sigma, n) {
  const ideal = Math.sqrt((12 * sigma * sigma) / n + 1);
  let wl = Math.floor(ideal);
  if (wl % 2 === 0) wl--;
  const m = Math.round((12 * sigma * sigma - n * wl * wl - 4 * n * wl - 3 * n) / (-4 * wl - 4));
  return Array.from({ length: n }, (_, i) => (i < m ? wl : wl + 2));
}

/**
 * Gaussian blur of a large-sigma kernel approximated by three box blurs
 * (O(1) per pixel whatever sigma is). Used only for lighting normalisation,
 * where the difference from an exact Gaussian does not matter.
 */
export function gaussianBlurApprox(src, w, h, sigma) {
  let a = Float32Array.from(src), b = new Float32Array(w * h);
  for (const size of boxSizes(sigma, 3)) {
    const r = (size - 1) >> 1, inv = 1 / size;
    for (let y = 0; y < h; y++) {                         // horizontal: a -> b
      const row = y * w;
      let acc = 0;
      for (let j = -r; j <= r; j++) acc += a[row + reflect101(j, w)];
      for (let x = 0; x < w; x++) {
        b[row + x] = acc * inv;
        acc += a[row + reflect101(x + r + 1, w)] - a[row + reflect101(x - r, w)];
      }
    }
    for (let x = 0; x < w; x++) {                         // vertical: b -> a
      let acc = 0;
      for (let j = -r; j <= r; j++) acc += b[reflect101(j, h) * w + x];
      for (let y = 0; y < h; y++) {
        a[y * w + x] = acc * inv;
        acc += b[reflect101(y + r + 1, h) * w + x] - b[reflect101(y - r, h) * w + x];
      }
    }
  }
  return a;
}

/**
 * Unwrap an image around (cx, cy) into an angle x radius grid (row-major,
 * one row per angle). Angles are maths convention with image y pointing down.
 * Bilinear, with the edge pixels repeated outside the image.
 */
export function remapPolar(img, w, h, cx, cy, pxPerMm, angsDeg, radsMm) {
  const nA = angsDeg.length, nR = radsMm.length, out = new Float32Array(nA * nR);
  const clampX = (v) => (v < 0 ? 0 : v > w - 1 ? w - 1 : v), clampY = (v) => (v < 0 ? 0 : v > h - 1 ? h - 1 : v);
  for (let i = 0; i < nA; i++) {
    const t = (angsDeg[i] * Math.PI) / 180, ca = Math.cos(t), sa = Math.sin(t);
    for (let j = 0; j < nR; j++) {
      const r = radsMm[j] * pxPerMm, x = cx + r * ca, y = cy - r * sa;
      const x0 = Math.floor(x), y0 = Math.floor(y), fx = x - x0, fy = y - y0;
      const xa = clampX(x0), xb = clampX(x0 + 1), ya = clampY(y0) * w, yb = clampY(y0 + 1) * w;
      out[i * nR + j] = (img[ya + xa] * (1 - fx) + img[ya + xb] * fx) * (1 - fy) + (img[yb + xa] * (1 - fx) + img[yb + xb] * fx) * fy;
    }
  }
  return out;
}
