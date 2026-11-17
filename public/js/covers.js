// Pochettes : chargement (via le proxy du serveur), couleur dominante, et
// pochette générée quand Last.fm n'en a pas.
//
// Sur « Tout », la ville compte plus de 1 000 tours. Une pochette 300×300 pèse
// ~0,5 Mo en mémoire graphique : 1 000 feraient 500 Mo. Les grandes tours ont
// donc la version 300×300, les petites la version 64×64 (20 fois plus légère),
// remplacée par la grande quand on ouvre l'album.
import * as THREE from 'three';

export const coverUrl = (id, size = '300x300') => (id ? `/api/cover/${size}/${id}` : null);

const cache = new Map(); // albumId -> Promise<CoverInfo>

function hashString(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

// Couleur « vivante » d'une image : on regroupe les pixels par teinte en
// favorisant les pixels saturés, et on garde le groupe le plus lourd.
function dominantColor(source) {
  const S = 32;
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = S;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(source, 0, 0, S, S);
  const { data } = ctx.getImageData(0, 0, S, S);

  const bins = Array.from({ length: 12 }, () => ({ w: 0, r: 0, g: 0, b: 0 }));
  let ar = 0, ag = 0, ab = 0;
  const tmp = new THREE.Color();
  const hsl = {};
  for (let i = 0; i < data.length; i += 4) {
    const r = data[i] / 255, g = data[i + 1] / 255, b = data[i + 2] / 255;
    ar += r; ag += g; ab += b;
    tmp.setRGB(r, g, b, THREE.SRGBColorSpace).getHSL(hsl, THREE.SRGBColorSpace);
    const v = Math.max(r, g, b);
    const weight = hsl.s * hsl.s * (v > 0.12 && v < 0.98 ? 1 : 0.08) + 0.0005;
    const bin = bins[Math.min(11, Math.floor(hsl.h * 12))];
    bin.w += weight; bin.r += r * weight; bin.g += g * weight; bin.b += b * weight;
  }
  const n = data.length / 4;
  const best = bins.reduce((a, b) => (b.w > a.w ? b : a));
  const color = new THREE.Color();
  if (best.w > 2) {
    color.setRGB(best.r / best.w, best.g / best.w, best.b / best.w, THREE.SRGBColorSpace);
  } else {
    color.setRGB(ar / n, ag / n, ab / n, THREE.SRGBColorSpace); // pochette presque grise
  }
  // On normalise pour que chaque tour reste lisible dans la nuit.
  color.getHSL(hsl, THREE.SRGBColorSpace);
  const s = best.w > 2 ? THREE.MathUtils.clamp(hsl.s * 1.15, 0.35, 0.92) : Math.min(hsl.s, 0.18);
  color.setHSL(hsl.h, s, THREE.MathUtils.clamp(hsl.l, 0.42, 0.62), THREE.SRGBColorSpace);
  return color;
}

function wrapText(ctx, text, maxWidth, maxLines) {
  const words = text.split(/\s+/);
  const lines = [];
  let line = '';
  for (const w of words) {
    const test = line ? `${line} ${w}` : w;
    if (ctx.measureText(test).width > maxWidth && line) {
      lines.push(line);
      line = w;
    } else line = test;
  }
  if (line) lines.push(line);
  if (lines.length > maxLines) {
    lines.length = maxLines;
    lines[maxLines - 1] = `${lines[maxLines - 1].replace(/.{0,2}$/, '')}…`;
  }
  return lines;
}

// Pochette dessinée quand Last.fm n'a pas d'image : couleur tirée du nom,
// sillons de disque et titre.
function generatedCover(album, size = 256) {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext('2d');
  const h = hashString(`${album.artist}|${album.name}`);
  const hue = h % 360;
  const hue2 = (hue + 35 + (h % 50)) % 360;

  const g = ctx.createLinearGradient(0, 0, size, size);
  g.addColorStop(0, `hsl(${hue} 70% 46%)`);
  g.addColorStop(1, `hsl(${hue2} 75% 22%)`);
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, size, size);

  const k = size / 256;
  ctx.strokeStyle = 'rgba(255,255,255,0.10)';
  ctx.lineWidth = Math.max(1, 1.5 * k);
  const cx = size * (0.62 + ((h >> 8) % 20) / 100);
  const cy = size * 0.38;
  for (let r = 14 * k; r < size * 0.9; r += 9 * k) {
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.stroke();
  }

  const color = new THREE.Color().setHSL(hue / 360, 0.68, 0.52, THREE.SRGBColorSpace);
  if (size < 128) return { canvas, color }; // trop petit pour du texte lisible

  ctx.fillStyle = 'rgba(255,255,255,0.94)';
  ctx.font = '700 26px system-ui, -apple-system, Segoe UI, sans-serif';
  const lines = wrapText(ctx, album.name, size - 36, 3);
  lines.forEach((l, i) => ctx.fillText(l, 18, size - 52 - (lines.length - 1 - i) * 30));
  ctx.fillStyle = 'rgba(255,255,255,0.7)';
  ctx.font = '500 17px system-ui, -apple-system, Segoe UI, sans-serif';
  ctx.fillText(wrapText(ctx, album.artist, size - 36, 1)[0] || '', 18, size - 22);

  return { canvas, color };
}

function loadImage(url) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.decoding = 'async';
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error(`pochette introuvable : ${url}`));
    img.src = url;
  });
}

function toTexture(source) {
  const tex = new THREE.Texture(source);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  tex.needsUpdate = true;
  return tex;
}

const generated = new Map(); // albumId -> CoverInfo

// Pochette immédiate (dessinée), utilisée tant que la vraie n'est pas arrivée
// ou quand Last.fm n'en a pas. `small` : version 64×64 pour les petites tours.
// L'image du panneau (src) n'est dessinée en grand que si on la demande.
export function placeholderCover(album, { small = false } = {}) {
  const have = generated.get(album.id);
  if (have && (small || have.hi)) return have;
  const gen = generatedCover(album, small ? 64 : 256);
  let src = null;
  const info = {
    texture: toTexture(gen.canvas),
    color: gen.color,
    generated: true,
    hi: !small,
    get src() {
      return (src ??= (small ? generatedCover(album, 256).canvas : gen.canvas).toDataURL('image/png'));
    },
    get thumb() {
      return this.src;
    },
  };
  generated.set(album.id, info);
  return info;
}

async function resolveCover(album, size) {
  const url = coverUrl(album.cover, size);
  if (!url) return null;
  try {
    const img = await loadImage(url);
    return {
      texture: toTexture(img),
      color: dominantColor(img),
      src: coverUrl(album.cover, '300x300'), // le panneau affiche toujours la grande
      thumb: coverUrl(album.cover, '64s'),
      generated: false,
      hi: size === '300x300',
    };
  } catch {
    return null; // on garde la pochette dessinée
  }
}

function cached(album, size) {
  const big = cache.get(`${album.id}|${album.cover}|300x300`);
  if (big) return big; // déjà chargée en grand : on ne redescend pas
  const key = `${album.id}|${album.cover}|${size}`;
  if (!cache.has(key)) cache.set(key, resolveCover(album, size));
  return cache.get(key);
}

// Charge les vraies pochettes, les plus écoutées d'abord (6 à la fois, la
// limite d'un navigateur par serveur). Les `bigCount` premiers albums ont la
// version 300×300, les autres la 64×64. onCover est appelé dès qu'une pochette
// est prête, pour la poser sur sa tour sans attendre les autres.
export async function loadCovers(albums, { bigCount = Infinity, onCover = () => {}, onProgress = () => {} } = {}) {
  let done = 0;
  const queue = albums.map((album, rank) => ({ album, size: rank < bigCount ? '300x300' : '64s' })).filter((q) => q.album.cover);
  const total = queue.length;
  const worker = async () => {
    while (queue.length) {
      const { album, size } = queue.shift();
      const info = await cached(album, size);
      if (info) onCover(album.id, info);
      onProgress(++done, total);
    }
  };
  await Promise.all(Array.from({ length: 6 }, worker));
}

// Version grand format d'une pochette (quand on ouvre un album).
export async function upgradeCover(album) {
  if (!album.cover) return placeholderCover(album);
  return (await cached(album, '300x300')) || placeholderCover(album);
}
