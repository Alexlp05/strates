// Transforme l'archive en ce que la ville doit dessiner pour une période :
// les albums (les tours), les couches, la frise et quelques statistiques.
//
// Quels albums ? Tous ceux écoutés au moins MIN_PLAYS fois (3 par défaut) ;
// sur une petite période (200 albums ou moins), tous les albums.
//
// Sur une grande période, une tour ne peut pas avoir 800 couches : on choisit
// une « unité » (1 couche = 1, 5, 25… écoutes) pour que la plus haute tour
// garde au plus ~40 couches et la ville au plus ~3000 couches en tout.

import { albumIdOf } from './lastfm.js';

const DAY = 86400;
export const RANGES = { recent: 0, '24h': DAY, '7d': 7 * DAY, '30d': 30 * DAY, '1y': 365 * DAY, all: Infinity };
const RECENT_COUNT = 200;
const UNITS = [1, 2, 3, 4, 5, 10, 15, 20, 25, 30, 40, 50, 75, 100, 150, 200, 250, 500, 1000, 2000, 5000, 10000];
const SMALL_CITY = 200; // en dessous de ce nombre d'albums, on les montre tous
const MAX_LAYERS_PER_TOWER = 40;
const MAX_LAYERS = 3000;
const HIST_STEPS = [900, 1800, 3600, 2 * 3600, 3 * 3600, 6 * 3600, 12 * 3600, DAY, 2 * DAY, 7 * DAY, 14 * DAY, 30 * DAY, 91 * DAY, 365 * DAY];
const HIST_MAX_BINS = 160;

function lowerBound(list, ts) {
  let lo = 0, hi = list.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (list[mid].ts < ts) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

export function buildView(history, { range, minPlays = 3, maxAlbums = 1500 }) {
  const now = Math.floor(Date.now() / 1000);
  const all = history.scrobbles;
  let list;
  let rangeFrom = null;
  if (range === 'recent') list = all.slice(-RECENT_COUNT);
  else if (range === 'all') list = all;
  else {
    rangeFrom = now - RANGES[range];
    list = all.slice(lowerBound(all, rangeFrom));
  }

  // 1. Regroupement par album
  const albums = new Map();
  const ids = new Array(list.length);
  const trackCounts = new Map();
  const hoursUtc = new Array(24).fill(0);
  list.forEach((s, i) => {
    const name = s.album || s.track; // un single sans album devient son propre « album »
    const id = albumIdOf(s.artist, name);
    ids[i] = id;
    let a = albums.get(id);
    if (!a) {
      a = { id, artist: s.artist, name, cover: s.cover, plays: 0, tracks: new Map(), times: [], trackOf: [] };
      albums.set(id, a);
    }
    if (!a.cover && s.cover) a.cover = s.cover;
    a.plays++;
    a.tracks.set(s.track, (a.tracks.get(s.track) || 0) + 1);
    a.times.push(s.ts);
    a.trackOf.push(s.track);
    const tk = `${s.track}\u0000${s.artist}`;
    trackCounts.set(tk, (trackCounts.get(tk) || 0) + 1);
    hoursUtc[Math.floor((s.ts % DAY) / 3600)]++;
  });

  let nowPlaying = null;
  if (history.nowPlaying) {
    const np = history.nowPlaying;
    const name = np.album || np.track;
    const id = albumIdOf(np.artist, name);
    nowPlaying = { track: np.track, artist: np.artist, album: name, albumId: id, cover: np.cover };
    if (!albums.has(id)) albums.set(id, { id, artist: np.artist, name, cover: np.cover, plays: 0, tracks: new Map(), times: [], trackOf: [] });
  }

  // 2. Les albums affichés : tous ceux écoutés au moins `minPlays` fois
  //    (tous si la période en compte peu), + celui en cours d'écoute.
  //    `maxAlbums` n'est qu'une sécurité pour les très grosses bibliothèques.
  const sorted = [...albums.values()].sort((a, b) => b.plays - a.plays || (b.times.at(-1) || 0) - (a.times.at(-1) || 0));
  const played = sorted.filter((a) => a.plays);
  const shown = (played.length <= SMALL_CITY ? played : played.filter((a) => a.plays >= minPlays)).slice(0, maxAlbums);
  if (nowPlaying && !shown.some((a) => a.id === nowPlaying.albumId)) shown.push(albums.get(nowPlaying.albumId));
  const shownIds = new Set(shown.map((a) => a.id));

  // 3. L'unité : combien d'écoutes par couche
  const maxPlays = Math.max(1, ...shown.map((a) => a.plays));
  const unit =
    UNITS.find((u) => Math.ceil(maxPlays / u) <= MAX_LAYERS_PER_TOWER && shown.reduce((n, a) => n + Math.ceil(a.plays / u), 0) <= MAX_LAYERS) ??
    UNITS.at(-1);

  // 4. Les couches : une couche apparaît au moment de sa première écoute
  const layers = [];
  for (const a of shown) {
    for (let i = 0; i < a.times.length; i += unit) {
      const n = Math.min(unit, a.times.length - i);
      const layer = { ts: a.times[i], albumId: a.id, n };
      if (unit === 1) layer.track = a.trackOf[i];
      else layer.te = a.times[i + n - 1];
      layers.push(layer);
    }
  }
  layers.sort((x, y) => x.ts - y.ts);

  // 5. Le cadre temporel et la frise
  let domain;
  if (!list.length) domain = [now - (Number.isFinite(RANGES[range]) && RANGES[range] ? RANGES[range] : DAY), now];
  else if (rangeFrom) domain = [rangeFrom, now];
  else {
    const t0 = list[0].ts;
    let t1 = list.at(-1).ts;
    if (nowPlaying && now - t1 < 6 * 3600) t1 = now;
    const pad = Math.max(60, (t1 - t0) * 0.015);
    domain = [Math.floor(t0 - pad), Math.ceil(t1 + pad)];
  }
  const histogram = buildHistogram(list, ids, shownIds, domain);

  // 6. Artistes et statistiques (sur toute la période, pas seulement les tours affichées)
  const artists = new Map();
  for (const a of sorted) {
    const k = a.artist.toLowerCase();
    const entry = artists.get(k) || { name: a.artist, plays: 0, albumIds: [] };
    entry.plays += a.plays;
    if (shownIds.has(a.id)) entry.albumIds.push(a.id);
    artists.set(k, entry);
  }
  const [topKey, topPlays] = [...trackCounts.entries()].sort((x, y) => y[1] - x[1])[0] || [];
  const latest = list.at(-1);

  const rangeComplete =
    history.complete ||
    (range === 'recent' ? all.length >= RECENT_COUNT : range === 'all' ? false : history.oldestTs !== null && history.oldestTs <= rangeFrom);

  return {
    user: history.user,
    range,
    rangeFrom,
    domain,
    total: Math.max(history.total, all.length),
    count: list.length,
    unit,
    complete: rangeComplete,
    nowPlaying,
    latest: latest ? { ts: latest.ts, track: latest.track, artist: latest.artist, albumId: ids.at(-1) } : null,
    albums: shown.map((a) => ({
      id: a.id,
      artist: a.artist,
      name: a.name,
      cover: a.cover,
      plays: a.plays,
      trackCount: a.tracks.size,
      // les 12 morceaux les plus écoutés : [titre, écoutes] (format court, il y a parfois 1000+ albums)
      tracks: [...a.tracks.entries()].sort((x, y) => y[1] - x[1]).slice(0, 12),
      first: a.times[0] ?? null,
      last: a.times.at(-1) ?? null,
    })),
    layers,
    artists: [...artists.values()].filter((a) => a.albumIds.length).sort((a, b) => b.plays - a.plays),
    histogram,
    stats: {
      listens: list.length,
      albums: [...albums.values()].filter((a) => a.plays).length,
      artists: artists.size,
      tracks: trackCounts.size,
      shownAlbums: shown.length,
      minPlays: shown.length < played.length ? minPlays : 1, // seuil réellement appliqué
      hoursUtc,
      topTrack: topKey ? { name: topKey.split('\u0000')[0], artist: topKey.split('\u0000')[1], plays: topPlays } : null,
    },
  };
}

// La frise : nombre d'écoutes par tranche de temps, avec le détail des
// albums (les 6 principaux de chaque tranche, le reste regroupé sous "").
function buildHistogram(list, ids, shownIds, [t0, t1]) {
  const span = Math.max(1, t1 - t0);
  const step = HIST_STEPS.find((s) => span / s <= HIST_MAX_BINS) || HIST_STEPS.at(-1);
  const n = Math.max(1, Math.ceil(span / step));
  const bins = Array.from({ length: n }, () => new Map());
  list.forEach((s, i) => {
    const b = Math.min(n - 1, Math.max(0, Math.floor((s.ts - t0) / step)));
    const id = shownIds.has(ids[i]) ? ids[i] : '';
    bins[b].set(id, (bins[b].get(id) || 0) + 1);
  });
  return {
    t0,
    step,
    bins: bins.map((m) => {
      const entries = [...m.entries()].sort((x, y) => y[1] - x[1]);
      const top = entries.filter(([id]) => id).slice(0, 6);
      const total = entries.reduce((sum, [, c]) => sum + c, 0);
      const rest = total - top.reduce((sum, [, c]) => sum + c, 0);
      if (rest) top.push(['', rest]);
      return [total, top];
    }),
  };
}
