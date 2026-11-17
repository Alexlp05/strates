// Les feats : les artistes invités sur un morceau, lus dans son titre.
//
// Last.fm (via Spotify, Deezer…) les écrit presque toujours dans le titre :
//   « 187 mesures (feat. Ninho) », « HELLO (feat. JEY BROWNIE & Josman) »,
//   « lovely (with Khalid) ».
// Le champ « artiste » n'est pas utilisé : « Bigflo & Oli » ou « Simon &
// Garfunkel » sont des groupes, pas des feats.
//
// Pour séparer plusieurs invités (« A & B », « A, B »), on reconnaît d'abord
// les artistes que l'utilisateur écoute déjà : « feat. Caballero & JeanJass »
// donne un seul invité si « Caballero & JeanJass » est un artiste connu.

const IN_BRACKETS = /[([]\s*(?:feat\.?|ft\.?|featuring|with)\s+([^)\]]+)[)\]]/gi;
const AT_END = /\s(?:feat\.?|ft\.?|featuring)\s+([^()[\]]+)\)?\s*$/i;
const SPLIT = /\s*,\s*|\s+(?:&|et|and|x)\s+/i;
const SEPARATOR = /^[\s,&]*$|^\s+(?:et|and|x)\s+$/i;

const memo = new Map(); // titre → invités (les mêmes titres reviennent souvent)
let memoKnown = null;

// known : Map nom en minuscules → nom tel qu'écrit (les artistes de l'archive),
// triée du nom le plus long au plus court.
export function featuredArtists(title, known) {
  if (memoKnown !== known) {
    memo.clear();
    memoKnown = known;
  }
  if (memo.has(title)) return memo.get(title);

  const parts = [...title.matchAll(IN_BRACKETS)].map((m) => m[1]);
  if (!parts.length) {
    const m = AT_END.exec(title);
    if (m) parts.push(m[1]);
  }
  const names = new Map(); // clé en minuscules → nom affiché
  for (const raw of parts) {
    let rest = raw.replace(/\s+-\s.*$/, '').trim(); // « X - Remix » → « X »
    // 1. les artistes connus, du plus long au plus court
    for (const [key, name] of known) {
      if (key.length > rest.length) continue;
      const i = rest.toLowerCase().indexOf(key);
      if (i < 0) continue;
      const before = rest.slice(0, i);
      const after = rest.slice(i + key.length);
      // il faut un nom entier, pas un morceau de nom (« Leto » dans « Toleto »)
      if (!/(^|[\s,&])$/.test(before) || !/^($|[\s,&)])/.test(after)) continue;
      names.set(key, name);
      rest = `${before} , ${after}`;
    }
    // 2. le reste, découpé aux séparateurs
    for (const piece of rest.split(SPLIT)) {
      const name = piece.replace(/^(?:[\s,&]|(?:et|and|x)\s)+/i, '').replace(/[\s,&]+$/, '');
      if (name.length > 1 && !SEPARATOR.test(name)) names.set(name.toLowerCase(), name);
    }
  }
  const result = [...names.values()];
  memo.set(title, result);
  return result;
}

// Les liens entre artistes sur une liste d'écoutes : une paire d'artistes,
// le nombre d'écoutes de leurs feats et les morceaux les plus écoutés.
export function buildFeats(list, known, max = 300) {
  const pairs = new Map();
  let listens = 0;
  for (const s of list) {
    const guests = featuredArtists(s.track, known);
    if (!guests.length) continue;
    const host = s.artist;
    let counted = false;
    for (const guest of guests) {
      if (guest.toLowerCase() === host.toLowerCase()) continue;
      // paire sans ordre : « A feat. B » et « B feat. A » forment le même lien
      const [a, b] = [host, guest].sort((x, y) => x.toLowerCase().localeCompare(y.toLowerCase()));
      const key = `${a.toLowerCase()}\u0000${b.toLowerCase()}`;
      let p = pairs.get(key);
      if (!p) pairs.set(key, (p = { a, b, plays: 0, tracks: new Map() }));
      p.plays++;
      p.tracks.set(s.track, (p.tracks.get(s.track) || 0) + 1);
      counted = true;
    }
    if (counted) listens++;
  }
  const feats = [...pairs.values()]
    .sort((x, y) => y.plays - x.plays)
    .slice(0, max)
    .map((p) => ({ a: p.a, b: p.b, plays: p.plays, tracks: [...p.tracks.entries()].sort((x, y) => y[1] - x[1]).slice(0, 3) }));
  return { feats, listens };
}

// Les artistes de l'archive (pour reconnaître les invités), recalculés
// seulement quand l'archive change.
const knownCache = new WeakMap();
export function knownArtists(history) {
  const cached = knownCache.get(history);
  if (cached && cached.version === history.version) return cached.known;
  const map = new Map();
  for (const s of history.scrobbles) {
    const key = s.artist.toLowerCase();
    if (key.length > 1 && !map.has(key)) map.set(key, s.artist);
  }
  const known = new Map([...map.entries()].sort((x, y) => y[0].length - x[0].length));
  knownCache.set(history, { version: history.version, known });
  return known;
}
