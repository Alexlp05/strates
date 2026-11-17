// Chef d'orchestre : charge les données depuis NOTRE serveur (jamais Last.fm),
// alimente la ville et la frise, gère le temps (direct, rejouer, parcourir)
// et tous les cas d'erreur.

import { City } from './city.js';
import { Timeline } from './timeline.js';
import { loadCovers, placeholderCover, upgradeCover, coverUrl } from './covers.js';
import { DATA_KEYS, DEFAULTS, loadSettings, renderSettings, saveSettings } from './settings.js';
import * as ui from './ui.js';

const $ = (id) => document.getElementById(id);
const { fmt } = ui;
const RETRY_SECONDS = 30;
const RANGES = ['recent', '24h', '7d', '30d', '1y', 'all'];
const RANGE_TEXT = {
  recent: 'tes 200 dernières écoutes',
  '24h': 'les dernières 24 h',
  '7d': 'les 7 derniers jours',
  '30d': 'les 30 derniers jours',
  '1y': 'la dernière année',
  all: 'tout ton historique',
};

class ApiError extends Error {
  constructor(code, message, status) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

async function api(path) {
  let res;
  try {
    res = await fetch(path, { headers: { Accept: 'application/json' } });
  } catch {
    throw new ApiError('NETWORK', 'Le serveur Strates ne répond pas.', 0);
  }
  let body = null;
  try {
    body = await res.json();
  } catch {
    /* corps vide ou non JSON */
  }
  if (!res.ok) throw new ApiError(body?.error?.code || `HTTP_${res.status}`, body?.error?.message || `Erreur ${res.status}.`, res.status);
  return body;
}

const store = {
  get(k) {
    try { return localStorage.getItem(k); } catch { return null; }
  },
  set(k, v) {
    try { localStorage.setItem(k, v); } catch { /* stockage indisponible */ }
  },
};

const params = new URLSearchParams(location.search);
const state = {
  config: null,
  user: params.get('user') || null,
  range: RANGES.includes(params.get('range')) ? params.get('range') : RANGES.includes(store.get('strates:range')) ? store.get('strates:range') : 'recent',
  settings: loadSettings(), // panneau « Réglages » (voir settings.js)
  data: null,
  meta: null,
  domain: [0, 1],
  covers: new Map(),
  mode: 'live',
  cursor: Infinity,
  replay: null,
  view: 'city',
  selected: null,
  pollTimer: null,
  retryTimer: null,
  retryAt: 0,
  loadToken: 0,
};

// ------------------------------------------------------------ mise en place

const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;
const lowPower = matchMedia('(pointer: coarse)').matches || Math.min(screen.width, screen.height) < 600 || (navigator.hardwareConcurrency || 8) <= 4;

function webglAvailable() {
  try {
    return Boolean(document.createElement('canvas').getContext('webgl2'));
  } catch {
    return false;
  }
}

let city = null;
if (webglAvailable()) {
  try {
    city = new City($('scene'), { labels: $('labels'), lowPower, reducedMotion, look: state.settings });
    city.start();
  } catch (err) {
    console.error('WebGL indisponible', err);
    city = null;
  }
}
if (!city) document.body.classList.add('no-webgl');

const timeline = new Timeline($('timeline'), $('timeline-track'));
// Les N albums les plus écoutés ont leur pochette en 300×300, les autres en 64×64.
const BIG_COVERS = lowPower ? 60 : 220;

const albumById = (id) => state.data?.albums.find((a) => a.id === id);
// Couleur d'un album dans la page (frise, classement…) : la même que sa tour,
// qui dépend du réglage « Couleurs des tours ».
const cssColor = (id) => {
  const c = city?.piles.get(id)?.color ?? state.covers.get(id)?.color;
  return c ? `#${c.getHexString()}` : '#888';
};

// ------------------------------------------------------------ chargement

// Les réglages « Données » partent avec la demande ; « Auto » = rien à envoyer.
function listeningUrl() {
  const p = new URLSearchParams({ user: state.user, range: state.range });
  for (const k of DATA_KEYS) if (state.settings[k] !== 'auto') p.set(k, state.settings[k]);
  return `/api/listening?${p}`;
}

// reshape : un réglage a changé, la ville se réorganise sans rejouer l'intro.
async function load({ intro = false, silent = false, reshape = false } = {}) {
  clearTimeout(state.pollTimer);
  stopRetry();
  if (!state.user) return askUser();
  const token = ++state.loadToken;
  if (!state.data && !silent) ui.setLoader('Chargement des écoutes…');
  try {
    const data = await api(listeningUrl());
    if (token !== state.loadToken) return;
    store.set(snapshotKey(), JSON.stringify({ savedAt: Date.now(), data }));
    state.meta = data.meta;
    await applyData(data, { intro, reshape });
    if (data.meta.stale) {
      ui.showBanner(`Last.fm ne répond pas. Tu vois les écoutes archivées par le serveur (Last.fm consulté ${fmt.ago(Date.now() - data.meta.fetchedAt)}).`);
    } else ui.showBanner(null);
    renderStatus();
    watchSync(data);
  } catch (err) {
    if (token !== state.loadToken) return;
    await handleError(err, { silent });
  } finally {
    if (token === state.loadToken) schedulePoll();
  }
}

async function applyData(data, { intro = false, reshape = false } = {}) {
  const prev = state.data;
  const first = !prev;
  // Pochette dessinée tout de suite ; la vraie la remplace dès qu'elle arrive.
  data.albums.forEach((album, rank) => {
    if (!state.covers.has(album.id)) state.covers.set(album.id, placeholderCover(album, { small: rank >= BIG_COVERS }));
  });
  const allCovers = loadCovers(data.albums, {
    bigCount: BIG_COVERS,
    onProgress: (done, total) => first && !state.data && ui.setLoader(`Pochettes ${done} / ${total}`),
    onCover: (id, info) => setCover(id, info),
  });
  // Au premier chargement, on laisse 2,5 s aux pochettes pour que l'intro
  // soit belle, puis on construit quoi qu'il arrive.
  if (first) await Promise.race([allCovers, new Promise((r) => setTimeout(r, 2500))]);

  state.data = data;
  state.domain = data.domain;
  // somme cumulée des écoutes par couche, pour compter ce qui est visible à l'instant T
  let sum = 0;
  state.prefix = data.layers.map((l) => (sum += l.n));
  ui.setLoader(null);
  ui.hideMessage();
  renderSummary(data);
  ui.renderRanking(data, state.covers, pickAlbum, cssColor);
  timeline.setData({ histogram: data.histogram, domain: state.domain, colorOf: cssColor });
  renderNowPlaying(data);

  if (!city) {
    renderFallback(data);
    setCursor(Infinity, 'live');
  } else {
    // nouvelle période, nouvel utilisateur ou nouvelle échelle (1 couche = n écoutes) : on reconstruit
    const rebuilt = intro || first || prev.range !== data.range || prev.user !== data.user || (!reshape && prev.unit !== data.unit);
    if (rebuilt) {
      stopReplay();
      city.clearFocus({ fly: false, silent: true });
      ui.hidePanel();
      state.selected = null;
      city.setCursor(-Infinity);
      city.setData(data, state.covers, { domain: state.domain });
      const duration = reducedMotion ? 0.6 : Math.min(6.5, 2.4 + data.layers.length * 0.012);
      city.intro(duration + 0.8);
      startReplay({ duration, intro: true });
    } else if (reshape && prev.unit !== data.unit) {
      // nouvelle échelle choisie dans les réglages : toutes les couches
      // changent, la ville repousse vite dans l'ordre des écoutes (sans l'intro)
      stopReplay();
      city.setCursor(-Infinity);
      city.setData(data, state.covers, { domain: state.domain });
      startReplay({ duration: reducedMotion ? 0.6 : 2.5 });
    } else {
      city.setData(data, state.covers, { domain: state.domain });
      if (state.mode === 'live') announce(prev, data);
      else city.setCursor(state.cursor);
      const pile = state.selected && city.piles.get(state.selected);
      if (pile) ui.showPanel(pile, data, state.domain);
    }
  }

  if (!data.layers.length && !data.nowPlaying && data.complete) showEmpty();
  renderSettingsPanel(); // (les notes du panneau dépendent des données)
}

// Remplace la pochette d'un album (et libère la mémoire graphique de l'ancienne).
function setCover(id, info) {
  const prev = state.covers.get(id);
  if (prev === info || (prev?.hi && !info.hi && !prev.generated)) return; // jamais de retour au petit format
  state.covers.set(id, info);
  if (state.data?.albums.some((a) => a.id === id)) {
    city?.updateCover(id, info);
    refreshCoverDom();
  }
  if (prev && prev.texture !== info.texture) prev.texture.dispose();
}

// On ouvre un album : sa pochette passe en grand format si besoin.
async function upgrade(id) {
  const album = albumById(id);
  if (!album || state.covers.get(id)?.hi) return;
  const info = await upgradeCover(album);
  if (info) setCover(id, info);
}

let coverDomTimer = null;
function refreshCoverDom() {
  clearTimeout(coverDomTimer);
  coverDomTimer = setTimeout(() => {
    if (!state.data) return;
    timeline.draw();
    ui.renderRanking(state.data, state.covers, pickAlbum, cssColor);
    renderNowPlaying(state.data);
    if (!city) renderFallback(state.data);
    const pile = state.selected && city?.piles.get(state.selected);
    if (pile) ui.showPanel(pile, state.data, state.domain);
  }, 300);
}

// Récupération de l'historique en cours sur le serveur : on affiche
// l'avancement (sans jamais appeler Last.fm depuis la page) et on reconstruit
// la ville quand la période demandée est entièrement archivée.
let syncTimer = null;
function watchSync(data) {
  clearTimeout(syncTimer);
  syncTimer = null;
  if (data.complete) return;
  if (data.meta?.sync?.state === 'limit') {
    // le serveur s'est arrêté à HISTORY_MAX_PAGES : on montre ce qu'il a, sans boucler
    const since = data.meta.sync.oldestTs ? fmt.dayYear.format(new Date(data.meta.sync.oldestTs * 1000)) : '?';
    ui.showBanner(`Historique limité par le serveur (HISTORY_MAX_PAGES) : écoutes depuis le ${since}.`, 'info');
    return;
  }
  const tick = async () => {
    let info;
    try {
      info = await api(`/api/sync?user=${encodeURIComponent(state.user)}`);
    } catch {
      syncTimer = setTimeout(tick, 5000);
      return;
    }
    if (state.data !== data) return (syncTimer = null); // autre période entre-temps
    const ready = info.complete || info.state === 'limit' || (data.rangeFrom && info.oldestTs && info.oldestTs <= data.rangeFrom);
    if (ready) {
      syncTimer = null;
      ui.showBanner(null);
      load({ intro: true });
      return;
    }
    const pct = info.total ? Math.floor((info.have / info.total) * 100) : 0;
    if (info.state === 'error') {
      ui.showBanner(`La récupération de ton historique s'est interrompue (${info.error}). Elle reprendra au prochain chargement.`);
      syncTimer = null;
      return;
    }
    ui.showBanner(
      `Récupération de ton historique Last.fm : ${pct} % (${info.have.toLocaleString('fr-FR')} / ${info.total.toLocaleString('fr-FR')} écoutes). ` +
        `Une seule fois : ensuite il est gardé par le serveur. La ville se reconstruira à la fin.`,
      'info',
    );
    syncTimer = setTimeout(tick, 2500);
  };
  syncTimer = setTimeout(tick, 1000);
}

// Nouvelles écoutes arrivées depuis le dernier rafraîchissement : une
// notification et une onde depuis la tour concernée.
function announce(prev, data) {
  const latest = data.latest;
  if (latest && latest.ts > (prev.latest?.ts || 0)) {
    ui.toast('Nouvelle écoute', `${latest.track} · ${latest.artist}`, cssColor(latest.albumId));
    city.pulse(latest.albumId);
  }
  const np = data.nowPlaying;
  if (np && (np.track !== prev.nowPlaying?.track || np.artist !== prev.nowPlaying?.artist)) {
    ui.toast('En écoute', `${np.track} · ${np.artist}`, cssColor(np.albumId));
    city.pulse(np.albumId, 0.7);
  }
}

// ------------------------------------------------------------ erreurs

const snapshotKey = () => `strates:v3:${(state.user || '').toLowerCase()}:${state.range}:${state.settings.unit}:${state.settings.minPlays}`;

async function handleError(err, { silent }) {
  ui.setLoader(null);
  if (!state.data) {
    $('user-btn').textContent = state.user || '…';
    $('summary').textContent = 'en attente des écoutes';
  }
  const unreachable = !['NO_API_KEY', 'USER_NOT_FOUND', 'BAD_USER', 'PRIVATE', 'BAD_RANGE'].includes(err.code);
  const title = err.code === 'NETWORK' ? 'Le serveur ne répond pas' : 'Last.fm ne répond pas';

  if (unreachable && state.data) {
    // On garde la ville affichée et on prévient.
    ui.showBanner(`${title}. La ville affichée date de ${fmt.ago(Date.now() - (state.meta?.fetchedAt || Date.now()))}. Nouvel essai automatique…`);
    ui.setStatus('hors ligne', 'warn');
    scheduleRetry();
    return;
  }

  if (unreachable) {
    let snapshot = null;
    try {
      snapshot = JSON.parse(store.get(snapshotKey()) || 'null');
    } catch {
      snapshot = null;
    }
    if (snapshot?.data) {
      state.meta = null;
      await applyData(snapshot.data, { intro: true });
      ui.showBanner(`${title}. Voici ta ville telle qu'elle était ${fmt.ago(Date.now() - snapshot.savedAt)} (sauvegardée sur cet appareil). Nouvel essai automatique…`);
      ui.setStatus('hors ligne · sauvegarde locale', 'warn');
      scheduleRetry();
      return;
    }
    ui.showMessage({
      icon: 'offline',
      title,
      text: `${err.message} Ta ville se construira dès qu'il répondra : la page réessaie toute seule.`,
      actions: [{ label: `Réessayer (${RETRY_SECONDS} s)`, primary: true, id: 'retry-btn', onClick: () => load({ intro: true }) }],
    });
    ui.setStatus('hors ligne', 'warn');
    scheduleRetry();
    return;
  }

  if (silent && state.data) return;
  switch (err.code) {
    case 'NO_API_KEY':
      ui.showMessage({ icon: 'key', title: 'Clé API manquante', text: err.message, actions: [{ label: 'Réessayer', primary: true, onClick: () => load({ intro: true }) }] });
      break;
    case 'PRIVATE':
      ui.showMessage({ icon: 'lock', title: 'Écoutes privées', text: `${err.message} Elles doivent être publiques dans les réglages de confidentialité de Last.fm.`, actions: [{ label: 'Autre utilisateur', primary: true, onClick: () => askUser() }] });
      break;
    default:
      askUser(err.message);
  }
  ui.setStatus('en attente', 'warn');
}

function scheduleRetry() {
  stopRetry();
  state.retryAt = Date.now() + RETRY_SECONDS * 1000;
  state.retryTimer = setInterval(() => {
    const left = Math.ceil((state.retryAt - Date.now()) / 1000);
    const btn = $('retry-btn');
    if (btn) btn.textContent = `Réessayer (${Math.max(0, left)} s)`;
    if (left <= 0) {
      stopRetry();
      load({ intro: !state.data, silent: Boolean(state.data) });
    }
  }, 1000);
}
function stopRetry() {
  clearInterval(state.retryTimer);
  state.retryTimer = null;
}

function schedulePoll() {
  clearTimeout(state.pollTimer);
  if (document.hidden || state.retryTimer) return;
  const every = Math.max(30, state.config?.cacheTtlSeconds || 60) * 1000;
  state.pollTimer = setTimeout(() => {
    // pendant une relecture ou une récupération d'historique, on attend la fin
    if (state.replay || syncTimer) schedulePoll();
    else load({ silent: true });
  }, every);
}

document.addEventListener('visibilitychange', () => {
  if (document.hidden) return clearTimeout(state.pollTimer);
  const age = state.meta ? Date.now() - state.meta.fetchedAt : Infinity;
  if (state.data && age > (state.config?.cacheTtlSeconds || 60) * 1000) load({ silent: true });
  else schedulePoll();
});

function askUser(reason) {
  ui.showMessage({
    icon: 'user',
    title: 'Quel compte Last.fm ?',
    text: reason || "Entre un nom d'utilisateur Last.fm pour dessiner sa ville d'écoutes.",
    input: {
      value: state.user || '',
      placeholder: 'pseudo Last.fm',
      label: "Nom d'utilisateur Last.fm",
      submit: 'Afficher',
      onSubmit: (value) => {
        if (!value) return;
        state.user = value;
        state.data = null;
        updateUrl();
        ui.hideMessage();
        load({ intro: true });
      },
    },
    actions: state.data ? [{ label: 'Annuler', onClick: ui.hideMessage }] : [],
  });
}

function showEmpty() {
  // des écoutes, mais aucun album n'atteint le minimum choisi dans les réglages
  if (state.data?.stats.albums) {
    ui.showMessage({
      icon: 'empty',
      title: 'Pas de tour',
      text: `Aucun album n'a été écouté ${state.settings.minPlays} fois ou plus sur ${RANGE_TEXT[state.range]}. Baisse le minimum d'écoutes dans les réglages.`,
      actions: [{ label: 'Ouvrir les réglages', primary: true, onClick: () => { ui.hideMessage(); toggleSettings(true); } }, { label: 'Fermer', onClick: ui.hideMessage }],
    });
    return;
  }
  const actions = state.range !== 'recent' ? [{ label: 'Voir mes 200 dernières écoutes', primary: true, onClick: () => setRange('recent') }] : [];
  ui.showMessage({
    icon: 'empty',
    title: 'Terrain vague',
    text: `Aucune écoute sur ${RANGE_TEXT[state.range]}. Lance un morceau : la première couche de ta ville apparaîtra ici toute seule.`,
    actions: [...actions, { label: 'Fermer', onClick: ui.hideMessage }],
  });
}

// ------------------------------------------------------------ le temps

function setCursor(T, mode) {
  state.cursor = T;
  state.mode = mode;
  city?.setCursor(T);
  timeline.setCursor(T);
  $('btn-live').hidden = mode === 'live';
  document.body.classList.toggle('in-past', mode !== 'live');
  renderClock();
}

function startReplay({ duration = 14, intro = false, resume = false } = {}) {
  const list = state.data?.layers || [];
  stopReplay();
  if (!list.length) return setCursor(Infinity, 'live');
  const N = list.length;
  const [t0, t1] = state.domain;
  let startP = 0;
  if (resume && Number.isFinite(state.cursor)) {
    const i = list.findIndex((s) => s.ts > state.cursor);
    startP = i <= 0 ? 0 : i / N;
  }
  const started = performance.now() - startP * duration * 1000;
  document.body.classList.toggle('intro', intro);
  $('btn-play').classList.add('playing');
  const tick = (now) => {
    // (l'horodatage de requestAnimationFrame peut précéder « started » : on borne)
    const p = Math.min(1, Math.max(0, (now - started) / (duration * 1000)));
    // On avance d'écoute en écoute (et non d'heure en heure) : les nuits
    // sans musique passent vite, les moments chargés prennent leur temps.
    const f = p * N;
    const i = Math.floor(f);
    const T = i >= N ? t1 : (i === 0 ? t0 : list[i - 1].ts) + ((list[i].ts - (i === 0 ? t0 : list[i - 1].ts)) * (f - i));
    if (p >= 1) {
      stopReplay();
      setCursor(Infinity, 'live');
      city?.pulse(null, 1.2);
      return;
    }
    setCursor(T, 'replay');
    state.replay = requestAnimationFrame(tick);
  };
  state.replay = requestAnimationFrame(tick);
}

function stopReplay() {
  if (state.replay) cancelAnimationFrame(state.replay);
  state.replay = null;
  $('btn-play').classList.remove('playing');
  document.body.classList.remove('intro');
}

function renderClock(hoverText) {
  const clock = $('clock');
  if (hoverText) {
    clock.textContent = hoverText;
    return;
  }
  const data = state.data;
  if (!data) return (clock.textContent = '—');
  const [t0, t1] = state.domain;
  const long = t1 - t0 > 300 * 86400; // sur plusieurs mois, on affiche l'année
  const date = (ts) => (long ? fmt.dayYear : fmt.dayTime).format(new Date(ts * 1000));
  if (state.mode === 'live') {
    clock.textContent = data.layers.length ? `${date(t0)} → ${date(t1)}` : RANGE_TEXT[state.range];
    return;
  }
  // nombre d'écoutes déjà « construites » à l'instant T
  const i = countUntil(data.layers, state.cursor);
  const visible = i ? state.prefix[i - 1] : 0;
  const when = long ? fmt.dayYear.format(new Date(state.cursor * 1000)) : fmt.time(state.cursor);
  clock.textContent = `${when} · ${visible.toLocaleString('fr-FR')} / ${data.count.toLocaleString('fr-FR')}`;
}

function countUntil(list, T) {
  let lo = 0, hi = list.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (list[mid].ts <= T) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

// ------------------------------------------------------------ rendu DOM

function renderSummary(data) {
  $('user-btn').textContent = data.user;
  const { albums, artists, shownAlbums } = data.stats;
  const parts = [fmt.plays(data.count) + (data.range === 'recent' ? ` sur ${data.total.toLocaleString('fr-FR')}` : '')];
  const minPlays = data.stats.minPlays;
  parts.push(`${albums.toLocaleString('fr-FR')} album${albums > 1 ? 's' : ''}${shownAlbums < albums ? ` (${shownAlbums.toLocaleString('fr-FR')} écoutés ${minPlays} fois ou plus en ville)` : ''}`);
  parts.push(`${artists.toLocaleString('fr-FR')} artiste${artists > 1 ? 's' : ''}`);
  if (data.unit > 1) parts.push(`1 couche = ${data.unit} écoutes`);
  $('summary').textContent = parts.join(' · ');
  document.title = `Strates · ${data.user}`;
}

function renderNowPlaying(data) {
  const el = $('now-playing');
  const np = data.nowPlaying;
  el.hidden = !np;
  if (!np) return;
  $('np-title').textContent = `${np.track} · ${np.artist}`;
  el.style.setProperty('--c', cssColor(np.albumId));
}

function renderStatus() {
  const meta = state.meta;
  if (!meta) return;
  const age = fmt.ago(Date.now() - meta.fetchedAt);
  if (meta.stale) ui.setStatus(`Last.fm injoignable · données ${age}`, 'warn');
  else if (meta.cache === 'HIT') ui.setStatus(`cache serveur · Last.fm consulté ${age}`, 'ok');
  else ui.setStatus(`Last.fm consulté ${age}`, 'ok');
}
setInterval(renderStatus, 15_000);

function renderFallback(data) {
  const el = $('fallback');
  const max = Math.max(1, ...data.albums.map((a) => a.plays));
  el.hidden = false;
  el.replaceChildren(
    ui.h('p', { class: 'fallback-note' }, "Ton navigateur n'affiche pas la 3D : voici ta ville vue du ciel, une tuile par album, plus elle est grande plus tu l'as écouté."),
    ...data.albums.filter((a) => a.plays).slice(0, 300).map((album) => {
      const info = state.covers.get(album.id);
      const size = album.plays / max > 0.6 ? 3 : album.plays / max > 0.25 ? 2 : 1;
      return ui.h('figure', { class: `tile s${size}` },
        ui.h('img', { src: info?.src || coverUrl(album.cover) || '', alt: '', loading: 'lazy' }),
        ui.h('figcaption', {}, ui.h('strong', {}, album.name), ui.h('span', {}, `${album.artist} · ${album.plays}`)));
    }),
  );
}

// ------------------------------------------------------------ interactions

function pickAlbum(id) {
  if (city) city.focusById(id);
  upgrade(id);
  if (window.innerWidth < 900) toggleRanking(false);
}

function toggleRanking(open = $('ranking').hidden) {
  $('ranking').hidden = !open;
  $('btn-rank').setAttribute('aria-pressed', String(open));
  if (open && window.innerWidth < 900) {
    city?.clearFocus();
    toggleSettings(false);
  }
}

// ------------------------------------------------------------ réglages

function toggleSettings(open = $('settings').hidden) {
  $('settings').hidden = !open;
  $('btn-settings').setAttribute('aria-pressed', String(open));
  if (!open) return;
  // le panneau prend la place de celui de l'album (à droite, ou en bas sur téléphone)
  ui.hidePanel();
  state.selected = null;
  city?.clearFocus({ silent: true });
  if (window.innerWidth < 900) toggleRanking(false);
  renderSettingsPanel();
}

function renderSettingsPanel() {
  if ($('settings').hidden) return;
  renderSettings($('settings-body'), state.settings, {
    data: state.data,
    defaultMinPlays: state.config?.minPlays ?? 3,
    hasBloom: Boolean(city?.composer),
    has3d: Boolean(city),
    onChange: changeSetting,
  });
}

function changeSetting(key, value) {
  const prev = state.settings;
  state.settings = key === 'reset' ? { ...DEFAULTS } : { ...prev, [key]: value };
  saveSettings(state.settings);
  city?.setLook(state.settings);
  // écoutes par couche ou minimum : le serveur refait la vue (sans rappeler Last.fm)
  if (DATA_KEYS.some((k) => state.settings[k] !== prev[k]) && state.user) load({ reshape: true });
  refreshCoverDom(); // frise, classement et panneau reprennent les couleurs des tours
  renderSettingsPanel();
}

function setRange(range) {
  if (!RANGES.includes(range)) return;
  state.range = range;
  store.set('strates:range', range);
  for (const b of document.querySelectorAll('#range button')) b.setAttribute('aria-pressed', String(b.dataset.range === range));
  updateUrl();
  ui.hideMessage();
  load({ intro: true });
}

function updateUrl() {
  const p = new URLSearchParams();
  if (state.user && state.user !== state.config?.defaultUser) p.set('user', state.user);
  if (state.range !== 'recent') p.set('range', state.range);
  const qs = p.toString();
  history.replaceState(null, '', qs ? `?${qs}` : location.pathname);
}

for (const b of document.querySelectorAll('#range button')) {
  b.setAttribute('aria-pressed', String(b.dataset.range === state.range));
  b.addEventListener('click', () => b.dataset.range !== state.range && setRange(b.dataset.range));
}

$('btn-view').addEventListener('click', () => {
  state.view = state.view === 'city' ? 'map' : 'city';
  const map = state.view === 'map';
  $('btn-view').setAttribute('aria-pressed', String(map));
  $('btn-view').querySelector('span').textContent = map ? 'Vue ville' : 'Vue carte';
  document.body.classList.toggle('map-view', map);
  city?.setView(state.view);
});

$('btn-rank').addEventListener('click', () => toggleRanking());
$('btn-settings').addEventListener('click', () => toggleSettings());
$('user-btn').addEventListener('click', () => askUser());
$('btn-live').addEventListener('click', () => {
  stopReplay();
  setCursor(Infinity, 'live');
});
$('btn-play').addEventListener('click', () => {
  if (state.replay) {
    stopReplay();
    setCursor(state.cursor, 'scrub');
  } else {
    const resume = state.mode === 'scrub' && state.cursor < (state.data?.layers.at(-1)?.ts ?? 0);
    startReplay({ duration: 14, resume });
  }
});
$('now-playing').addEventListener('click', () => {
  const id = state.data?.nowPlaying?.albumId;
  if (id && city) city.focusById(id);
});

for (const btn of document.querySelectorAll('[data-close]')) {
  btn.addEventListener('click', () => {
    if (btn.dataset.close === 'panel') {
      ui.hidePanel();
      state.selected = null;
      city?.clearFocus({ silent: true });
    } else if (btn.dataset.close === 'settings') toggleSettings(false);
    else toggleRanking(false);
  });
}

document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  if (!$('panel').hidden) {
    ui.hidePanel();
    state.selected = null;
    city?.clearFocus({ silent: true });
  } else if (!$('settings').hidden) toggleSettings(false);
  else if (!$('ranking').hidden) toggleRanking(false);
  else if (ui.messageVisible() && state.data) ui.hideMessage();
});

if (city) {
  city.addEventListener('hover', (e) => (e.detail ? ui.showTooltip(e.detail) : ui.hideTooltip()));
  city.addEventListener('select', (e) => {
    const pile = e.detail.pile;
    ui.hideTooltip();
    if (!pile) {
      ui.hidePanel();
      state.selected = null;
      return;
    }
    state.selected = pile.id;
    upgrade(pile.id);
    toggleSettings(false);
    if (window.innerWidth < 900) toggleRanking(false);
    ui.showPanel(pile, state.data, state.domain);
  });
}

timeline.addEventListener('scrub', (e) => {
  stopReplay();
  setCursor(e.detail.T, 'scrub');
});
timeline.addEventListener('hover', (e) => {
  const bin = e.detail?.bin;
  city?.highlight(bin ? new Set(bin.albums.keys()) : null);
  if (!bin) return renderClock();
  const top = [...bin.albums.entries()].filter(([id]) => id).sort((a, b) => b[1] - a[1])[0];
  const album = top && albumById(top[0]);
  // tranche d'un jour ou plus : on affiche la date (et l'année), sinon l'heure
  const when = timeline.step >= 86400 ? fmt.span(bin.start, bin.end - 1) : fmt.time(bin.start);
  renderClock(`${when} · ${fmt.plays(bin.count)}${album ? ` · surtout ${album.name}` : ''}`);
});

// ------------------------------------------------------------ démarrage

(async function boot() {
  try {
    state.config = await api('/api/config');
  } catch (err) {
    ui.setLoader(null);
    ui.showMessage({
      icon: 'offline',
      title: 'Le serveur ne répond pas',
      text: `${err.message} Vérifie que docker compose up tourne, puis recharge la page.`,
      actions: [{ label: 'Recharger', primary: true, onClick: () => location.reload() }],
    });
    return;
  }
  state.user ||= state.config.defaultUser;
  updateUrl();
  if (!state.config.hasApiKey) {
    // Inutile de demander un pseudo : sans clé, le serveur ne peut rien chercher.
    ui.setLoader(null);
    $('summary').textContent = 'configuration incomplète';
    ui.showMessage({
      icon: 'key',
      title: 'Clé API manquante',
      text: "Le serveur n'a pas de clé API Last.fm. Copie .env.example en .env, ajoute ta clé et ton pseudo, puis relance docker compose up.",
      actions: [{ label: 'Recharger', primary: true, onClick: () => location.reload() }],
    });
    return;
  }
  load({ intro: true });
})();
