// L'archive des écoutes : le « cache » longue durée du serveur.
//
// - Au premier passage, un seul appel à Last.fm ramène les 200 dernières
//   écoutes : la page peut s'afficher tout de suite.
// - En tâche de fond, on remonte ensuite tout l'historique, 200 écoutes par
//   appel, du plus récent au plus ancien (paramètre `to`). Une seule fois :
//   l'archive est enregistrée sur le disque (volume Docker) et survit aux
//   redémarrages.
// - Ensuite, chaque rafraîchissement coûte au plus un appel (la page 1, qui
//   contient les nouvelles écoutes et le morceau en cours), et jamais plus
//   d'un par CACHE_TTL_SECONDS, quel que soit le nombre de visiteurs.
// - Si Last.fm tombe, on sert l'archive telle quelle (STALE).

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fetchRecentTracks, parseTracks } from './lastfm.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const keyOf = (s) => `${s.ts}|${s.artist}|${s.track}`;
const ERROR_TTL_MS = 10_000;
const FATAL = new Set(['USER_NOT_FOUND', 'PRIVATE', 'BAD_API_KEY']);

export class HistoryStore {
  constructor({ dir, apiKey, ttlMs, maxPages = 1000, pauseMs = 250 }) {
    Object.assign(this, { dir, apiKey, ttlMs, maxPages, pauseMs });
    this.users = new Map();
  }

  async get(user) {
    const id = user.toLowerCase();
    if (!this.users.has(id)) {
      const history = new UserHistory(user, this);
      history.loading = history.load();
      this.users.set(id, history);
    }
    const history = this.users.get(id);
    await history.loading;
    return history;
  }

  peek(user) {
    return this.users.get(user.toLowerCase()) || null;
  }

  forget(user) {
    this.users.delete(user.toLowerCase());
  }
}

class UserHistory {
  constructor(user, store) {
    this.user = user;
    this.store = store;
    this.scrobbles = []; // triées de la plus ancienne à la plus récente
    this.keys = new Set();
    this.total = 0; // nombre total d'écoutes du compte, d'après Last.fm
    this.complete = false; // tout l'historique est dans l'archive
    this.nowPlaying = null;
    this.checkedAt = 0; // dernier appel réussi à Last.fm
    this.version = 0; // change à chaque modification (sert au cache des vues)
    this.lastError = null;
    this.lastErrorAt = 0;
    this.refreshing = null;
    this.backfilling = null;
    this.sync = { state: 'idle', error: null };
    this.views = new Map();
  }

  get file() {
    return path.join(this.store.dir, `${this.user.toLowerCase()}.json`);
  }
  get oldestTs() {
    return this.scrobbles[0]?.ts ?? null;
  }
  get newestTs() {
    return this.scrobbles.at(-1)?.ts ?? null;
  }

  syncInfo() {
    return {
      state: this.complete ? 'done' : this.sync.state,
      error: this.sync.error,
      have: this.scrobbles.length,
      total: Math.max(this.total, this.scrobbles.length),
      oldestTs: this.oldestTs,
      complete: this.complete,
    };
  }

  // ------------------------------------------------------------ disque

  async load() {
    try {
      const raw = JSON.parse(await readFile(this.file, 'utf8'));
      if (raw.v !== 1) return;
      const S = raw.strings;
      this.scrobbles = raw.rows.map(([ts, a, b, t, c]) => ({ ts, artist: S[a], album: S[b], track: S[t], cover: c >= 0 ? S[c] : null }));
      this.keys = new Set(this.scrobbles.map(keyOf));
      this.total = raw.total || this.scrobbles.length;
      this.complete = Boolean(raw.complete);
      this.user = raw.user || this.user;
      this.version++;
      console.log(`[archive] ${this.user} : ${this.scrobbles.length} écoutes relues depuis le disque${this.complete ? ' (historique complet)' : ''}`);
    } catch (err) {
      if (err.code !== 'ENOENT') console.warn(`[archive] lecture impossible (${err.message}), on repart de zéro`);
    }
  }

  // Format compact : chaque texte (artiste, album…) n'est écrit qu'une fois.
  async save() {
    clearTimeout(this.saveTimer);
    this.saveTimer = null;
    const strings = [];
    const index = new Map();
    const idx = (s) => {
      if (s == null) return -1;
      let i = index.get(s);
      if (i === undefined) {
        i = strings.push(s) - 1;
        index.set(s, i);
      }
      return i;
    };
    const rows = this.scrobbles.map((s) => [s.ts, idx(s.artist), idx(s.album), idx(s.track), idx(s.cover)]);
    const body = JSON.stringify({ v: 1, user: this.user, total: this.total, complete: this.complete, savedAt: Date.now(), strings, rows });
    await mkdir(this.store.dir, { recursive: true });
    const tmp = `${this.file}.tmp`;
    await writeFile(tmp, body);
    await rename(tmp, this.file); // écriture atomique : jamais de fichier à moitié écrit
  }

  scheduleSave() {
    if (this.saveTimer) return;
    this.saveTimer = setTimeout(() => this.save().catch((e) => console.warn(`[archive] sauvegarde impossible : ${e.message}`)), 5000);
  }

  merge(items) {
    let added = 0;
    for (const s of items) {
      const k = keyOf(s);
      if (this.keys.has(k)) continue;
      this.keys.add(k);
      this.scrobbles.push(s);
      added++;
    }
    if (added) {
      this.scrobbles.sort((a, b) => a.ts - b.ts);
      this.version++;
      this.scheduleSave();
    }
    return added;
  }

  // ------------------------------------------------------------ nouvelles écoutes

  async refresh() {
    const now = Date.now();
    if (now - this.checkedAt < this.store.ttlMs) return { status: 'HIT' };
    if (this.lastError && now - this.lastErrorAt < ERROR_TTL_MS) return this.#fallback(this.lastError);
    const leader = !this.refreshing;
    if (leader) this.refreshing = this.#pull().finally(() => (this.refreshing = null));
    try {
      await this.refreshing;
      return { status: leader ? 'MISS' : 'HIT' };
    } catch (err) {
      return this.#fallback(err);
    }
  }

  #fallback(error) {
    if (this.scrobbles.length && !FATAL.has(error.code)) return { status: 'STALE', error };
    throw error;
  }

  async #pull() {
    const newest = this.newestTs;
    const items = [];
    let first = null;
    try {
      // Page 1 = les 200 plus récentes + le morceau en cours. Il ne faut une
      // page de plus que si plus de 200 écoutes ont eu lieu depuis la dernière fois.
      for (let page = 1; page <= 25; page++) {
        const parsed = parseTracks(await fetchRecentTracks({ apiKey: this.store.apiKey, user: this.user, page }));
        first ??= parsed;
        items.push(...parsed.scrobbles);
        const pageOldest = Math.min(...parsed.scrobbles.map((s) => s.ts));
        if (newest === null || !parsed.scrobbles.length || page >= parsed.totalPages || pageOldest <= newest) break;
      }
    } catch (err) {
      this.lastError = err;
      this.lastErrorAt = Date.now();
      throw err;
    }
    this.lastError = null;
    if (first.user) this.user = first.user;
    this.total = first.total || this.total;
    const npChanged = JSON.stringify(first.nowPlaying) !== JSON.stringify(this.nowPlaying);
    this.nowPlaying = first.nowPlaying;
    const added = this.merge(items);
    if (npChanged && !added) this.version++;
    if (!this.complete && this.total && this.scrobbles.length >= this.total) this.complete = true;
    this.checkedAt = Date.now();
  }

  // ------------------------------------------------------------ tout l'historique

  ensureBackfill() {
    if (this.complete || this.backfilling || !this.scrobbles.length || this.sync.state === 'limit') return;
    this.backfilling = this.#backfill()
      .catch((err) => {
        this.sync = { state: 'error', error: err.message };
        console.warn(`[archive] ${this.user} : récupération interrompue (${err.message})`);
      })
      .finally(() => {
        this.backfilling = null;
        this.save().catch(() => {});
      });
  }

  async #backfill() {
    this.sync = { state: 'running', error: null };
    console.log(`[archive] ${this.user} : récupération de tout l'historique (${this.total} écoutes)…`);
    let to = this.oldestTs;
    let failures = 0;
    for (let i = 0; i < this.store.maxPages; i++) {
      let parsed;
      try {
        parsed = parseTracks(await fetchRecentTracks({ apiKey: this.store.apiKey, user: this.user, to, label: 'archive' }));
        failures = 0;
      } catch (err) {
        if (FATAL.has(err.code) || ++failures >= 6) throw err;
        await sleep(3000 * failures); // Last.fm fatigué : on attend un peu plus à chaque fois
        continue;
      }
      if (!parsed.scrobbles.length) {
        this.complete = true;
        break;
      }
      const added = this.merge(parsed.scrobbles);
      // Si la page n'apporte rien (écoutes à la même seconde en limite de page),
      // on recule d'une seconde pour ne pas boucler.
      to = added ? this.oldestTs : Math.min(to ?? Infinity, ...parsed.scrobbles.map((s) => s.ts)) - 1;
      if (i % 10 === 0) console.log(`[archive] ${this.user} : ${this.scrobbles.length} / ${this.total} écoutes`);
      await sleep(this.store.pauseMs);
    }
    this.sync = { state: this.complete ? 'done' : 'limit', error: null };
    console.log(`[archive] ${this.user} : ${this.scrobbles.length} écoutes archivées${this.complete ? ', historique complet' : ' (limite HISTORY_MAX_PAGES atteinte)'}`);
  }
}
