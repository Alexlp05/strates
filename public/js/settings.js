// Le panneau « Réglages ».
//
// Deux sortes de réglages :
// - « Données » (écoutes par couche, minimum d'écoutes) : envoyés à NOTRE
//   serveur avec la demande d'écoutes ; il reconstruit la vue et la ville se
//   réorganise. Last.fm n'est pas rappelé pour autant : le serveur repart de
//   son archive.
// - tout le reste ne change que l'affichage : la ville 3D l'applique tout de
//   suite (voir City.setLook dans city.js).
// Les réglages sont gardés dans ce navigateur (localStorage), jamais ailleurs.

import { h } from './ui.js';
import { LOOK_DEFAULTS, SCALES, SKIES } from './city.js';

export const DEFAULTS = { unit: 'auto', minPlays: 'auto', ...LOOK_DEFAULTS };
export const DATA_KEYS = ['unit', 'minPlays'];

const CHOICES = {
  unit: ['auto', 1, 2, 5, 10, 20, 50, 100],
  minPlays: ['auto', 1, 2, 3, 5, 10, 20],
  colors: ['cover', 'artist', 'time', 'plays', 'mono'],
  sky: Object.keys(SKIES),
  shape: ['square', 'round', 'hexagon'],
};
const MONO = ['#a68bff', '#57c7ff', '#5ee6a8', '#ffb547', '#ff7ab6', '#f2f2f7'];
const KEY = 'strates:settings';

const COLOR_TEXT = {
  cover: ['Pochettes', 'Chaque tour prend la couleur de sa pochette.'],
  artist: ['Artistes', 'Une couleur par artiste : les quartiers ressortent.'],
  time: ['Récence', 'Selon la dernière écoute : froid pour les albums oubliés, chaud pour ceux du moment.'],
  plays: ['Écoutes', "Selon le nombre d'écoutes : plus un album est écouté, plus il est clair."],
  mono: ['Unie', 'Une seule couleur : seule la hauteur des tours parle.'],
};
const SHAPE_TEXT = { square: 'Carré', round: 'Rond', hexagon: 'Hexagone' };
const SHAPE_ICON = {
  square: 'M5 5h14v14H5z',
  round: 'M12 4a8 8 0 1 0 0 16 8 8 0 0 0 0-16z',
  hexagon: 'M12 3.5 19.4 7.8v8.4L12 20.5l-7.4-4.3V7.8z',
};
const SWITCHES = [
  ['labels', 'Noms des quartiers'],
  ['plates', 'Sols des quartiers'],
  ['stars', 'Étoiles et poussière'],
  ['grid', 'Grille et radar au sol'],
  ['bloom', 'Halo lumineux'],
  ['rotate', 'Rotation automatique'],
];

// Lit les réglages enregistrés ; toute valeur inconnue reprend sa valeur par défaut.
export function loadSettings() {
  let saved = {};
  try {
    saved = JSON.parse(localStorage.getItem(KEY) || '{}') || {};
  } catch {
    saved = {};
  }
  const s = { ...DEFAULTS };
  for (const k of Object.keys(DEFAULTS)) {
    const v = saved[k];
    if (CHOICES[k] ? CHOICES[k].includes(v) : typeof v === typeof DEFAULTS[k]) s[k] = v;
  }
  if (!/^#[0-9a-f]{6}$/i.test(s.mono)) s.mono = DEFAULTS.mono;
  return s;
}

export function saveSettings(s) {
  try {
    localStorage.setItem(KEY, JSON.stringify(s));
  } catch {
    /* stockage indisponible : les réglages valent pour cette visite */
  }
}

// Dessine le panneau. Appelée à chaque changement (le panneau est petit).
export function renderSettings(root, s, { data, defaultMinPlays = 3, hasBloom = true, has3d = true, onChange }) {
  const focused = document.activeElement?.dataset?.focus; // pour garder le focus clavier

  const options = (key, values, label = String, cls = '') =>
    h('div', { class: `opts ${cls}`, role: 'group' },
      ...values.map((v) =>
        h('button', { type: 'button', 'aria-pressed': String(s[key] === v), 'data-focus': `${key}:${v}`, onclick: () => s[key] !== v && onChange(key, v) }, label(v)),
      ),
    );
  const row = (title, control, note) =>
    h('div', { class: 'set-row' }, h('p', { class: 'set-label' }, title), control, note ? h('p', { class: 'set-note' }, note) : null);
  const section = (title, ...rows) => h('section', { class: 'set-section' }, h('h3', {}, title), ...rows);
  const plural = (n, word) => `${n.toLocaleString('fr-FR')} ${word}${n > 1 ? 's' : ''}`;

  // --- données
  let unitNote = null;
  let minNote = null;
  if (data) {
    unitNote = s.unit !== 'auto' && data.unit !== s.unit
      ? `Trop de couches pour ${s.unit} sur cette période : 1 couche = ${plural(data.unit, 'écoute')}.`
      : `Ici : 1 couche = ${plural(data.unit, 'écoute')}.`;
    const st = data.stats;
    minNote = `${plural(st.shownAlbums, 'album')} en ville sur ${st.albums.toLocaleString('fr-FR')}`
      + (s.minPlays === 'auto' ? ` (auto : ${defaultMinPlays} écoutes ou plus, tous les albums sur une petite période).` : '.');
  }
  const dataSection = section('Données',
    row('Écoutes par couche', options('unit', CHOICES.unit, (v) => (v === 'auto' ? 'Auto' : v)), unitNote),
    row("Minimum d'écoutes pour une tour", options('minPlays', CHOICES.minPlays, (v) => (v === 'auto' ? 'Auto' : v)), minNote),
  );

  // --- couleurs
  const [, colorHint] = COLOR_TEXT[s.colors];
  const scale = SCALES[s.colors];
  const legend = scale
    ? h('div', { class: 'legend' },
        h('i', { style: { background: `linear-gradient(90deg, ${scale.join(', ')})` } }),
        h('span', {}, s.colors === 'time' ? 'ancienne' : 'peu'),
        h('span', {}, s.colors === 'time' ? 'récente' : 'beaucoup'))
    : null;
  const mono = s.colors === 'mono'
    ? h('div', { class: 'mono-row', role: 'group', 'aria-label': 'Couleur' },
        ...MONO.map((c) =>
          h('button', { type: 'button', style: { '--c': c }, 'aria-pressed': String(s.mono === c), 'aria-label': c, 'data-focus': `mono:${c}`, onclick: () => onChange('mono', c) })),
        h('input', { type: 'color', value: s.mono, 'aria-label': 'Autre couleur', 'data-focus': 'mono:input', onchange: (e) => onChange('mono', e.target.value) }))
    : null;
  const colorSection = section('Couleurs des tours',
    h('div', { class: 'set-row' }, options('colors', CHOICES.colors, (v) => COLOR_TEXT[v][0], 'cols-3'), h('p', { class: 'set-note' }, colorHint), legend, mono),
  );

  // --- fond
  const skySection = section('Fond',
    h('div', { class: 'skies', role: 'group' },
      ...CHOICES.sky.map((k) => {
        const sky = SKIES[k];
        return h('button', { type: 'button', class: 'sky-btn', 'aria-pressed': String(s.sky === k), 'data-focus': `sky:${k}`, onclick: () => onChange('sky', k) },
          h('i', { style: { '--g': `radial-gradient(120% 70% at 50% 100%, ${sky.mood} 0%, ${sky.fog} 60%, ${sky.top} 100%)` } }),
          sky.name);
      }),
    ),
  );

  // --- forme et disposition
  const svg = (d) => {
    const NS = 'http://www.w3.org/2000/svg';
    const el = document.createElementNS(NS, 'svg');
    el.setAttribute('viewBox', '0 0 24 24');
    el.setAttribute('aria-hidden', 'true');
    const path = document.createElementNS(NS, 'path');
    path.setAttribute('d', d);
    el.append(path);
    return el;
  };
  const shapeSection = section('Forme',
    row('Tours', h('div', { class: 'opts shapes', role: 'group' },
      ...CHOICES.shape.map((k) =>
        h('button', { type: 'button', 'aria-pressed': String(s.shape === k), 'data-focus': `shape:${k}`, onclick: () => onChange('shape', k) }, svg(SHAPE_ICON[k]), SHAPE_TEXT[k])),
    ), s.shape === 'round' ? 'Chaque tour devient une pile de vinyles.' : null),
    row('Disposition', options('group', [true, false], (v) => (v ? 'Quartiers par artiste' : 'Par écoutes')),
      s.group ? null : 'Plus de quartiers : les albums les plus écoutés au centre, en spirale.'),
  );

  // --- effets
  const effects = section('Effets',
    h('div', { class: 'switches' },
      ...SWITCHES.filter(([k]) => k !== 'bloom' || hasBloom).map(([k, label]) =>
        h('label', { class: 'switch' }, h('span', {}, label),
          h('input', { type: 'checkbox', role: 'switch', checked: s[k], 'data-focus': `switch:${k}`, onchange: (e) => onChange(k, e.target.checked) }))),
    ),
  );

  root.replaceChildren(
    dataSection,
    ...(has3d ? [colorSection, skySection, shapeSection, effects] : [h('p', { class: 'set-note' }, "Sans 3D, seuls les réglages de données s'appliquent.")]),
    h('button', { type: 'button', class: 'chip set-reset', 'data-focus': 'reset', onclick: () => onChange('reset') }, 'Tout remettre par défaut'),
  );
  if (focused) root.querySelector(`[data-focus="${CSS.escape(focused)}"]`)?.focus();
}
