// Small helpers that reproduce Python semantics the ported code relies on.

/** Python's float modulo: the result has the sign of the divisor. */
export const pymod = (a, n) => ((a % n) + n) % n;

/** Python's round(): halves go to the nearest even integer. */
export function pyround(x) {
  const r = Math.round(x);
  return Math.abs(x % 1) === 0.5 && r % 2 !== 0 ? r - 1 : r;
}

/** numpy.median (mean of the two middle values for an even count). */
export function median(values) {
  const a = Float64Array.from(values).sort();
  const n = a.length;
  if (!n) return NaN;
  return n % 2 ? a[(n - 1) >> 1] : 0.5 * (a[n / 2 - 1] + a[n / 2]);
}

/** numpy.arange(start, stop, step) for positive steps. */
export function arange(start, stop, step) {
  const n = Math.max(0, Math.ceil((stop - start) / step));
  const out = new Float64Array(n);
  for (let i = 0; i < n; i++) out[i] = start + i * step;
  return out;
}

/** numpy.interp for increasing xp (clamps outside the range). */
export function interp(x, xp, fp) {
  const n = xp.length;
  if (x <= xp[0]) return fp[0];
  if (x >= xp[n - 1]) return fp[n - 1];
  let lo = 0, hi = n - 1;
  while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (xp[mid] <= x) lo = mid; else hi = mid; }
  return fp[lo] + (fp[hi] - fp[lo]) * (x - xp[lo]) / (xp[hi] - xp[lo]);
}
