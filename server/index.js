// Serveur de Strates.
// Le navigateur ne parle qu'à ce serveur ; seul ce serveur parle à Last.fm.

import express from 'express';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';
import { LruCache } from './cache.js';
import { HistoryStore } from './history.js';
import { COVER_HOSTS, LastfmError, lastfmCalls } from './lastfm.js';
import { RANGES, UNITS, buildView } from './view.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PUBLIC_DIR = path.join(ROOT, 'public');
const THREE_DIR = path.join(ROOT, 'node_modules', 'three');

const PORT = Number(process.env.PORT || 3000);
const API_KEY = (process.env.LASTFM_API_KEY || '').trim();
const DEFAULT_USER = (process.env.LASTFM_USER || '').trim();
const TTL_S = Number(process.env.CACHE_TTL_SECONDS || 60);
// Albums affichés : ceux écoutés au moins MIN_PLAYS fois, dans la limite de MAX_ALBUMS.
const MIN_PLAYS = Math.max(1, Number(process.env.MIN_PLAYS || 3));
const MAX_ALBUMS = Math.min(2500, Math.max(20, Number(process.env.MAX_ALBUMS || 1500)));

// Règle Last.fm : 2 à 15 caractères, commence par une lettre.
const USER_RE = /^[A-Za-z][A-Za-z0-9_-]{1,14}$/;

const history = new HistoryStore({
  dir: process.env.DATA_DIR || path.join(ROOT, 'data'),
  apiKey: API_KEY,
  ttlMs: TTL_S * 1000,
  maxPages: Number(process.env.HISTORY_MAX_PAGES || 1000),
  pauseMs: Number(process.env.HISTORY_PAUSE_MS || 250),
});
const covers = new LruCache(2500); // ~1 200 petites pochettes + les grandes
const coverInflight = new Map();

// --- Content-Security-Policy -------------------------------------------------
// connect-src 'self' : même si un script le voulait, le navigateur refuserait
// d'appeler Last.fm directement. L'import map inline est autorisée par son hash.
function importMapHash() {
  const html = readFileSync(path.join(PUBLIC_DIR, 'index.html'), 'utf8').replace(/\r\n?/g, '\n');
  const m = /<script type="importmap">([\s\S]*?)<\/script>/.exec(html);
  return m ? `'sha256-${createHash('sha256').update(m[1]).digest('base64')}'` : '';
}
const CSP = [
  "default-src 'self'",
  `script-src 'self' ${importMapHash()}`,
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "connect-src 'self'",
  "font-src 'self'",
  "object-src 'none'",
  "base-uri 'self'",
  "frame-ancestors 'self'",
].join('; ');

const app = express();
app.disable('x-powered-by');
app.use((req, res, next) => {
  res.setHeader('Content-Security-Policy', CSP);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  next();
});

// --- API ----------------------------------------------------------------------

app.get('/api/config', (req, res) => {
  res.set('Cache-Control', 'no-store');
  res.json({
    defaultUser: DEFAULT_USER || null,
    hasApiKey: Boolean(API_KEY),
    ranges: Object.keys(RANGES),
    cacheTtlSeconds: TTL_S,
    minPlays: MIN_PLAYS, // valeur « Auto » du réglage « minimum d'écoutes »
  });
});

// Réglages envoyés par la page. Valeur absente ou invalide → choix automatique.
function viewOptions(query) {
  const min = Number(query.minPlays);
  const unit = Number(query.unit);
  return {
    minPlays: Number.isInteger(min) && min >= 1 && min <= 100 ? min : null,
    unit: UNITS.includes(unit) ? unit : 'auto',
  };
}

app.get('/api/listening', async (req, res) => {
  res.set('Cache-Control', 'no-store');
  const user = String(req.query.user || DEFAULT_USER).trim();
  const range = String(req.query.range || 'recent');

  if (!API_KEY) {
    return sendError(res, new LastfmError(
      "Le serveur n'a pas de clé API Last.fm. Copie .env.example en .env, ajoute ta clé puis relance docker compose up.",
      { status: 503, code: 'NO_API_KEY' },
    ));
  }
  if (!USER_RE.test(user)) {
    return sendError(res, new LastfmError("Nom d'utilisateur Last.fm invalide.", { status: 400, code: 'BAD_USER' }));
  }
  if (!(range in RANGES)) {
    return sendError(res, new LastfmError('Période inconnue.', { status: 400, code: 'BAD_RANGE' }));
  }

  const opts = viewOptions(req.query);
  const key = `${user.toLowerCase()}|${range}|min=${opts.minPlays ?? 'auto'}|unit=${opts.unit}`;
  try {
    const archive = await history.get(user);
    // Au plus un appel à Last.fm par CACHE_TTL_SECONDS, partagé par tous.
    const result = await archive.refresh();
    const view = viewFor(archive, range, opts);
    // La période demande des écoutes plus anciennes que l'archive : on va
    // les chercher en tâche de fond (une seule fois).
    if (!view.complete) archive.ensureBackfill();

    const ageSeconds = Math.round((Date.now() - archive.checkedAt) / 1000);
    console.log(`[api] /api/listening ${key} → ${result.status} (Last.fm consulté il y a ${ageSeconds}s, ${view.count} écoutes, 1 couche = ${view.unit})`);
    res.set('X-Cache', result.status);
    sendJson(req, res, {
      ...view,
      meta: {
        cache: result.status,
        fetchedAt: archive.checkedAt || Date.now(),
        ageSeconds,
        ttlSeconds: TTL_S,
        stale: result.status === 'STALE',
        warning: result.status === 'STALE' ? result.error?.message : undefined,
        warningCode: result.status === 'STALE' ? result.error?.code : undefined,
        sync: archive.syncInfo(),
      },
    });
  } catch (err) {
    if (err.code === 'USER_NOT_FOUND') history.forget(user);
    console.warn(`[api] /api/listening ${key} → erreur ${err.code || ''} ${err.message}`);
    sendError(res, err);
  }
});

// Une vue par période et par réglages, recalculée seulement si l'archive a
// changé (ou toutes les 30 s pour les périodes glissantes « 24 h », « 7 j »…).
// On en garde au plus 16 : des réglages au hasard ne peuvent pas remplir la mémoire.
const MAX_VIEWS = 16;
function viewFor(archive, range, { minPlays, unit }) {
  const key = `${range}|${minPlays ?? 'auto'}|${unit}`;
  const cached = archive.views.get(key);
  if (cached && cached.version === archive.version && Date.now() - cached.at < 30_000) return cached.view;
  const view = buildView(archive, { range, minPlays: minPlays ?? MIN_PLAYS, strict: minPlays !== null, unit, maxAlbums: MAX_ALBUMS });
  archive.views.delete(key); // (réinsérée à la fin : la Map garde l'ordre d'utilisation)
  archive.views.set(key, { version: archive.version, at: Date.now(), view });
  if (archive.views.size > MAX_VIEWS) archive.views.delete(archive.views.keys().next().value);
  return view;
}

// Avancement de la récupération de l'historique. Ne contacte jamais Last.fm.
app.get('/api/sync', (req, res) => {
  res.set('Cache-Control', 'no-store');
  const user = String(req.query.user || DEFAULT_USER).trim();
  const archive = USER_RE.test(user) ? history.peek(user) : null;
  res.json(archive ? archive.syncInfo() : { state: 'idle', have: 0, total: 0, oldestTs: null, complete: false });
});

// Le JSON d'une grande période pèse quelques centaines de Ko : on le compresse.
function sendJson(req, res, body) {
  const json = JSON.stringify(body);
  res.set('Content-Type', 'application/json; charset=utf-8');
  res.set('Vary', 'Accept-Encoding');
  if (json.length > 2048 && /\bgzip\b/.test(req.headers['accept-encoding'] || '')) {
    res.set('Content-Encoding', 'gzip');
    return res.send(gzipSync(json));
  }
  res.send(json);
}

// Proxy des pochettes : les images sont sur le CDN de Last.fm, on les fait
// passer par ici pour que le navigateur ne contacte jamais Last.fm (et pour
// pouvoir lire leurs couleurs dans un <canvas> / WebGL sans souci de CORS).
const COVER_SIZES = new Set(['64s', '174s', '300x300']);
app.get('/api/cover/:size/:host/:file', async (req, res) => {
  const { size, host, file } = req.params;
  if (!COVER_SIZES.has(size) || !COVER_HOSTS[host] || !/^[a-f0-9]{32}\.(jpg|jpeg|png|gif|webp)$/.test(file)) {
    return res.status(400).end();
  }
  const key = `${size}/${host}/${file}`;
  let hit = covers.get(key);
  let status = 'HIT';
  if (!hit) {
    status = 'MISS';
    if (!coverInflight.has(key)) {
      coverInflight.set(key, (async () => {
        try {
          const r = await fetch(`https://${COVER_HOSTS[host]}/i/u/${size}/${file}`, { signal: AbortSignal.timeout(8000) });
          const type = r.headers.get('content-type') || '';
          if (!r.ok || !type.startsWith('image/')) return null;
          const buf = Buffer.from(await r.arrayBuffer());
          if (buf.length > 3 * 1024 * 1024) return null;
          const entry = { buf, type };
          covers.set(key, entry);
          return entry;
        } catch {
          return null;
        } finally {
          coverInflight.delete(key);
        }
      })());
    }
    hit = await coverInflight.get(key);
  }
  if (!hit) return res.status(404).set('Cache-Control', 'public, max-age=300').end();
  res.set({ 'Content-Type': hit.type, 'Cache-Control': 'public, max-age=604800, immutable', 'X-Cache': status });
  res.send(hit.buf);
});

app.get('/api/health', (req, res) => {
  res.set('Cache-Control', 'no-store');
  res.json({
    ok: true,
    uptimeSeconds: Math.round(process.uptime()),
    lastfmCalls: lastfmCalls(),
    archives: [...history.users.values()].map((a) => ({ user: a.user, ...a.syncInfo() })),
    cacheTtlSeconds: TTL_S,
  });
});

app.use('/api', (req, res) => res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Route inconnue.' } }));

// --- Fichiers statiques -------------------------------------------------------
// Three.js est servi depuis node_modules : pas de CDN, le navigateur ne parle
// qu'à ce serveur.
app.use('/vendor/three/build', express.static(path.join(THREE_DIR, 'build'), { maxAge: '7d' }));
app.use('/vendor/three/addons', express.static(path.join(THREE_DIR, 'examples', 'jsm'), { maxAge: '7d' }));
app.use(express.static(PUBLIC_DIR, { maxAge: 0 }));

function sendError(res, err) {
  const status = err instanceof LastfmError ? err.status : 500;
  const code = err instanceof LastfmError ? err.code : 'INTERNAL';
  const message = err instanceof LastfmError ? err.message : 'Erreur interne du serveur.';
  if (!(err instanceof LastfmError)) console.error(err);
  res.status(status).json({ error: { code, message } });
}

const server = app.listen(PORT, () => {
  console.log(`Strates écoute sur http://localhost:${PORT}`);
  console.log(`  utilisateur par défaut : ${DEFAULT_USER || '(aucun)'}`);
  console.log(`  clé API : ${API_KEY ? 'présente' : 'ABSENTE (voir .env.example)'} · Last.fm consulté au plus toutes les ${TTL_S}s`);
  // L'archive de l'utilisateur par défaut se remplit dès le démarrage, pour
  // que « 1 an » et « Tout » soient prêts quand on les ouvre.
  if (API_KEY && USER_RE.test(DEFAULT_USER)) {
    history
      .get(DEFAULT_USER)
      .then(async (archive) => {
        await archive.refresh();
        archive.ensureBackfill();
      })
      .catch((err) => console.warn(`[archive] démarrage : ${err.message}`));
  }
});

// À l'arrêt (docker compose down), on enregistre les archives avant de quitter.
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, async () => {
    await Promise.allSettled([...history.users.values()].map((a) => a.save()));
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 2000).unref();
  });
}
