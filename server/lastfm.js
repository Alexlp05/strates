// Tout ce qui parle à Last.fm est ici. Le navigateur ne voit jamais ce fichier
// ni la clé : il ne reçoit que le JSON simplifié produit par view.js.

import { createHash } from 'node:crypto';

const API_URL = process.env.LASTFM_API_URL || 'https://ws.audioscrobbler.com/2.0/';
const TIMEOUT_MS = Number(process.env.LASTFM_TIMEOUT_MS || 8000);

// Hôtes d'images autorisés. Le navigateur ne reçoit qu'un identifiant court
// (« b/abcdef….jpg ») et le serveur reconstruit l'URL : impossible de lui
// faire télécharger autre chose qu'une pochette Last.fm.
export const COVER_HOSTS = {
  a: 'lastfm.freetls.fastly.net',
  b: 'lastfm-img.freetls.fastly.net',
  c: 'lastfm-img2.akamaized.net',
};
const HOST_IDS = Object.fromEntries(Object.entries(COVER_HOSTS).map(([id, host]) => [host, id]));
// Image « étoile grise » que Last.fm renvoie quand il n'a pas de pochette.
const PLACEHOLDER_HASH = '2a96cbd8b46e442fc41c2b86b821562f';

let callCount = 0;
export const lastfmCalls = () => callCount;

export class LastfmError extends Error {
  constructor(message, { status = 502, code = 'LASTFM_DOWN', cause } = {}) {
    super(message, { cause });
    this.status = status;
    this.code = code;
  }
}

// Codes d'erreur documentés : https://www.last.fm/api/errorcodes
function mapLastfmError(body, httpStatus) {
  const code = Number(body?.error);
  const msg = body?.message || `HTTP ${httpStatus}`;
  switch (code) {
    case 6:
      return new LastfmError(`Utilisateur introuvable sur Last.fm (${msg}).`, { status: 404, code: 'USER_NOT_FOUND' });
    case 17:
      return new LastfmError('Les écoutes de cet utilisateur sont privées.', { status: 403, code: 'PRIVATE' });
    case 10:
    case 26:
      return new LastfmError('La clé API Last.fm est refusée.', { status: 500, code: 'BAD_API_KEY' });
    case 29:
      return new LastfmError('Last.fm limite le nombre de requêtes, réessaie dans un instant.', { status: 503, code: 'RATE_LIMITED' });
    default:
      return new LastfmError(`Last.fm a renvoyé une erreur (${msg}).`, { status: 502, code: 'LASTFM_DOWN' });
  }
}

function redact(url) {
  const copy = new URL(url);
  copy.searchParams.set('api_key', '***');
  return copy.toString();
}

// Un appel à user.getRecentTracks (200 écoutes max par page).
// `to` = ne renvoyer que les écoutes antérieures à ce timestamp (sert à
// remonter l'historique page après page).
export async function fetchRecentTracks({ apiKey, user, page = 1, limit = 200, to, label = '' }) {
  const url = new URL(API_URL);
  const params = {
    method: 'user.getrecenttracks',
    user,
    api_key: apiKey,
    format: 'json',
    limit: String(limit),
    page: String(page),
  };
  if (to) params.to = String(to);
  url.search = new URLSearchParams(params).toString();

  let res;
  // Last.fm renvoie parfois un 503 passager : on retente une seule fois.
  for (let attempt = 0; attempt < 2; attempt++) {
    callCount += 1;
    console.log(`[last.fm] appel #${callCount}${label ? ` (${label})` : ''} → ${redact(url)}${attempt ? ' (nouvel essai)' : ''}`);
    try {
      res = await fetch(url, {
        signal: AbortSignal.timeout(TIMEOUT_MS),
        headers: { 'User-Agent': 'Strates/1.0 (student project)', Accept: 'application/json' },
      });
    } catch (cause) {
      throw new LastfmError('Last.fm est injoignable pour le moment.', { status: 503, code: 'LASTFM_UNREACHABLE', cause });
    }
    if (res.status < 500 || attempt === 1) break;
    await res.body?.cancel();
    await new Promise((r) => setTimeout(r, 600));
  }

  let body;
  try {
    body = await res.json();
  } catch (cause) {
    throw new LastfmError(`Réponse illisible de Last.fm (HTTP ${res.status}).`, { status: 502, code: 'LASTFM_DOWN', cause });
  }
  if (body?.error || !res.ok) throw mapLastfmError(body, res.status);
  if (!body?.recenttracks) throw new LastfmError('Réponse inattendue de Last.fm.', { status: 502, code: 'LASTFM_DOWN' });
  return body.recenttracks;
}

const text = (v) => (typeof v === 'string' ? v : v?.['#text'] || v?.name || '').trim();

export function coverId(images) {
  const list = Array.isArray(images) ? images : [];
  const best = list.find((i) => i.size === 'extralarge') || list[list.length - 1];
  const url = best?.['#text'];
  if (!url) return null;
  const m = /^https?:\/\/([^/]+)\/i\/u\/[^/]+\/([a-f0-9]{32})\.(jpg|jpeg|png|gif|webp)$/i.exec(url);
  if (!m || !HOST_IDS[m[1]] || m[2] === PLACEHOLDER_HASH) return null;
  return `${HOST_IDS[m[1]]}/${m[2].toLowerCase()}.${m[3].toLowerCase()}`;
}

// Identifiant stable d'un album (artiste + titre), mémorisé car calculé
// pour chacune des dizaines de milliers d'écoutes.
const albumIds = new Map();
export function albumIdOf(artist, album) {
  const key = `${artist.toLowerCase()}\u0000${album.toLowerCase()}`;
  let id = albumIds.get(key);
  if (!id) {
    id = createHash('sha1').update(key).digest('hex').slice(0, 12);
    albumIds.set(key, id);
  }
  return id;
}

// Réponse brute de Last.fm → écoutes simples { ts, artist, album, track, cover }.
export function parseTracks(recent) {
  const attr = recent?.['@attr'] || {};
  const raw = Array.isArray(recent?.track) ? recent.track : recent?.track ? [recent.track] : [];
  const scrobbles = [];
  let nowPlaying = null;
  for (const t of raw) {
    const item = {
      artist: text(t.artist) || 'Artiste inconnu',
      album: text(t.album),
      track: (t.name || '').trim() || 'Sans titre',
      cover: coverId(t.image),
    };
    if (t['@attr']?.nowplaying === 'true') {
      nowPlaying ??= item;
      continue;
    }
    const ts = Number(t.date?.uts);
    if (ts) scrobbles.push({ ts, ...item });
  }
  return {
    user: attr.user || null,
    total: Number(attr.total || 0),
    totalPages: Number(attr.totalPages || 1),
    scrobbles,
    nowPlaying,
  };
}
