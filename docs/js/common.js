// Small helpers shared by the pages.

export const REPO = 'shihanqu/fisher-price-record-studio';

/** Fill the header's GitHub pill with the live star count (public API, no token needed). */
export function initStarBadge(id = 'gh-stars') {
  const el = document.getElementById(id);
  if (!el) return;
  fetch(`https://api.github.com/repos/${REPO}`)
    .then((r) => (r.ok ? r.json() : null))
    .then((d) => { el.innerHTML = d && typeof d.stargazers_count === 'number' ? '&#9733; ' + d.stargazers_count.toLocaleString() : '&#9733;'; })
    .catch(() => { el.innerHTML = '&#9733;'; });
}

/** Offer a Blob as a download. */
export function saveBlob(blob, name) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 10000);
}

export const baseName = (name) => (name || '').replace(/^.*[\\/]/, '').replace(/\.[^.]+$/, '');
export const fileSafe = (s, fallback = 'record') => (s || '').trim().replace(/\s+/g, '_').replace(/[^\w.-]/g, '') || fallback;
