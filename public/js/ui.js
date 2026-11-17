// Tout le DOM autour de la scène : panneau d'album, classement, info-bulle,
// messages d'erreur, bannière, notifications. Les textes venant de Last.fm
// sont toujours insérés avec textContent (jamais innerHTML).

const $ = (id) => document.getElementById(id);

export function h(tag, props = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'style') for (const [prop, val] of Object.entries(v)) el.style.setProperty(prop.replace(/[A-Z]/g, (m) => `-${m.toLowerCase()}`), val);
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k in el && typeof v !== 'string') el[k] = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat()) {
    if (c == null || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}

const plural = (n, one, many = `${one}s`) => `${n.toLocaleString('fr-FR')} ${n > 1 ? many : one}`;
export const fmt = {
  plays: (n) => plural(n, 'écoute'),
  dayYear: new Intl.DateTimeFormat('fr-FR', { day: 'numeric', month: 'short', year: 'numeric' }),
  month: new Intl.DateTimeFormat('fr-FR', { month: 'long', year: 'numeric' }),
  // « 3 mars 2024 » ou « 3 mars 2024 → 12 avr. 2024 »
  span(a, b) {
    const x = fmt.dayYear.format(new Date(a * 1000));
    const y = fmt.dayYear.format(new Date(b * 1000));
    return x === y ? x : `${x} → ${y}`;
  },
  full: new Intl.DateTimeFormat('fr-FR', { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }),
  day: new Intl.DateTimeFormat('fr-FR', { day: 'numeric', month: 'short' }),
  dayTime: new Intl.DateTimeFormat('fr-FR', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }),
  time: (ts) => fmt.full.format(new Date(ts * 1000)),
  ago(ms) {
    const s = Math.max(0, Math.round(ms / 1000));
    if (s < 10) return "à l'instant";
    if (s < 60) return `il y a ${s} s`;
    const m = Math.round(s / 60);
    if (m < 60) return `il y a ${m} min`;
    const hh = Math.round(m / 60);
    if (hh < 48) return `il y a ${hh} h`;
    return `le ${fmt.day.format(new Date(Date.now() - ms))}`;
  },
};

// ------------------------------------------------------------ info-bulle

const tooltip = $('tooltip');
export function showTooltip({ pile, slab, x, y }) {
  const { album, info } = pile;
  tooltip.replaceChildren(
    h('img', { src: info?.thumb || info?.src || '', alt: '', width: 44, height: 44 }),
    h(
      'div',
      { class: 'tt-text' },
      h('strong', {}, album.name),
      h('span', {}, pile.district ? `${album.artist} · quartier de ${pile.district.piles.length} albums` : album.artist),
      h('em', {}, album.plays ? fmt.plays(album.plays) : 'en écoute'),
      slab ? h('span', { class: 'tt-slab' }, slabText(slab)) : null,
    ),
  );
  tooltip.hidden = false;
  const pad = 14;
  const r = tooltip.getBoundingClientRect();
  const left = Math.min(window.innerWidth - r.width - 8, x + pad);
  const top = y + pad + r.height > window.innerHeight - 8 ? y - r.height - pad : y + pad;
  tooltip.style.transform = `translate(${Math.max(8, left)}px, ${Math.max(8, top)}px)`;
}
export const hideTooltip = () => (tooltip.hidden = true);

// Une couche = une écoute (morceau + heure) ou, sur les grandes périodes,
// un paquet d'écoutes (n° des écoutes + dates).
function slabText(slab) {
  if (slab.track) return `♪ ${slab.track} · ${fmt.time(slab.ts)}`;
  const from = slab.index * slab.unit + 1;
  const to = from + slab.n - 1;
  return `écoutes ${from.toLocaleString('fr-FR')} à ${to.toLocaleString('fr-FR')} · ${fmt.span(slab.ts, slab.te)}`;
}

// ------------------------------------------------------------ panneau album

const panel = $('panel');
const panelBody = $('panel-body');

export function showPanel(pile, data, domain) {
  const { album, info, color } = pile;
  const css = `#${color.getHexString()}`;
  const total = data.count || 1;
  const rank = data.albums.filter((a) => a.plays > album.plays).length + 1;
  const layers = data.layers.filter((l) => l.albumId === album.id);
  const unit = data.unit || 1;
  const long = domain[1] - domain[0] > 300 * 86400;
  const when = (ts) => (long ? fmt.dayYear.format(new Date(ts * 1000)) : fmt.time(ts));
  const layerCount = Math.ceil(album.plays / unit);
  const maxTrack = Math.max(1, ...album.tracks.map(([, plays]) => plays));
  const [t0, t1] = domain;
  const span = Math.max(1, t1 - t0);
  const isNow = data.nowPlaying?.albumId === album.id;

  panel.style.setProperty('--accent', css);
  panelBody.replaceChildren(
    h('div', { class: 'p-cover' }, h('img', { src: info?.src || '', alt: `Pochette de ${album.name}` })),
    h('div', { class: 'p-head' },
      h('p', { class: 'p-artist' }, album.artist),
      h('h2', {}, album.name),
      pile.district
        ? h('p', { class: 'p-district' }, h('i'), `Quartier ${pile.district.name} · ${pile.district.piles.length} albums · ${fmt.plays(pile.district.plays)}`)
        : null,
      isNow ? h('p', { class: 'p-now' }, h('span', { class: 'eq', 'aria-hidden': 'true' }, h('i'), h('i'), h('i'), h('i')), `En écoute : ${data.nowPlaying.track}`) : null,
    ),
    h('div', { class: 'p-stats' },
      unit > 1
        ? h('div', {}, h('strong', {}, album.plays.toLocaleString('fr-FR')), h('span', {}, `écoutes · ${layerCount} couche${layerCount > 1 ? 's' : ''} de ${unit}`))
        : h('div', {}, h('strong', {}, String(album.plays)), h('span', {}, album.plays > 1 ? 'couches · écoutes' : 'couche · écoute')),
      h('div', {}, h('strong', {}, `${Math.round((album.plays / total) * 100)} %`), h('span', {}, 'de la période')),
      h('div', {}, h('strong', {}, album.plays ? `#${rank}` : '—'), h('span', {}, 'au classement')),
    ),
    album.first
      ? h('p', { class: 'p-dates' }, album.first === album.last ? `Écouté ${when(album.first)}` : `Du ${when(album.first)} au ${when(album.last)}`)
      : null,
    layers.length
      ? h('div', { class: 'p-strip', title: 'Moments où tu as écouté cet album' },
          layers.map((l) => h('i', { style: { left: `${((l.ts - t0) / span) * 100}%`, width: l.te ? `max(2px, ${((l.te - l.ts) / span) * 100}%)` : null } })))
      : null,
    album.trackCount > album.tracks.length ? h('p', { class: 'p-more' }, `Les ${album.tracks.length} morceaux les plus écoutés sur ${album.trackCount}`) : null,
    album.tracks.length
      ? h('ol', { class: 'p-tracks' },
          album.tracks.map(([name, plays]) =>
            h('li', {},
              h('span', { class: 'p-track-name' }, name),
              h('span', { class: 'p-track-bar' }, h('i', { style: { width: `${(plays / maxTrack) * 100}%` } })),
              h('span', { class: 'p-track-count' }, `×${plays.toLocaleString('fr-FR')}`),
            ),
          ))
      : null,
  );
  panel.hidden = false;
  panel.scrollTop = 0;
}
export const hidePanel = () => (panel.hidden = true);

// ------------------------------------------------------------ classement

export function renderRanking(data, covers, onPick) {
  const stats = $('stats');
  const list = $('rank-list');
  const s = data.stats;
  // le serveur compte par heure UTC ; on décale vers l'heure locale du navigateur
  const offset = Math.round(-new Date().getTimezoneOffset() / 60);
  const utcPeak = s.hoursUtc.indexOf(Math.max(...s.hoursUtc));
  const peak = (((utcPeak + offset) % 24) + 24) % 24;

  stats.replaceChildren(
    h('div', {}, h('strong', {}, data.count.toLocaleString('fr-FR')), h('span', {}, 'écoutes')),
    h('div', {}, h('strong', {}, s.albums.toLocaleString('fr-FR')), h('span', {}, 'albums')),
    h('div', {}, h('strong', {}, s.artists.toLocaleString('fr-FR')), h('span', {}, 'artistes')),
    data.count ? h('div', {}, h('strong', {}, `${String(peak).padStart(2, '0')} h`), h('span', {}, 'heure favorite')) : null,
    s.topTrack && s.topTrack.plays > 1
      ? h('p', { class: 'stats-wide' }, 'Morceau le plus rejoué : ', h('b', {}, s.topTrack.name), ` · ${s.topTrack.artist} (×${s.topTrack.plays.toLocaleString('fr-FR')})`)
      : null,
    s.shownAlbums < s.albums ? h('p', { class: 'stats-wide' }, `La ville montre les ${s.shownAlbums.toLocaleString('fr-FR')} albums écoutés au moins ${s.minPlays} fois (sur ${s.albums.toLocaleString('fr-FR')}).`) : null,
  );

  const max = Math.max(1, ...data.albums.map((a) => a.plays));
  list.replaceChildren(
    ...data.albums
      .filter((a) => a.plays)
      .slice(0, 60)
      .map((album, i) => {
        const info = covers.get(album.id);
        return h('li', {},
          h('button', { type: 'button', onclick: () => onPick(album.id) },
            h('span', { class: 'r-rank' }, String(i + 1)),
            h('img', { src: info?.thumb || '', alt: '', width: 40, height: 40, loading: 'lazy' }),
            h('span', { class: 'r-text' }, h('strong', {}, album.name), h('span', {}, album.artist)),
            h('span', { class: 'r-count', style: { '--w': `${(album.plays / max) * 100}%`, '--c': `#${info?.color.getHexString() || '888888'}` } }, album.plays.toLocaleString('fr-FR')),
          ),
        );
      }),
  );
}

// ------------------------------------------------------------ messages

const message = $('message');
const ICONS = {
  offline: 'M4 12a8 8 0 0 1 13.66-5.66M20 12a8 8 0 0 1-13.66 5.66M3 3l18 18',
  key: 'M15 7a4 4 0 1 0-3.87 5H11l-1 1H8v2H6v2H3v-3l6.13-6.13A4 4 0 0 0 15 7Zm1-1h.01',
  user: 'M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8Zm-7 8a7 7 0 0 1 14 0',
  empty: 'M4 18h16M7 14h10M10 10h4',
  lock: 'M7 11V8a5 5 0 0 1 10 0v3M5 11h14v10H5z',
};

export function showMessage({ icon = 'offline', title, text, actions = [], input = null }) {
  const NS = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  const path = document.createElementNS(NS, 'path');
  path.setAttribute('d', ICONS[icon] || ICONS.offline);
  svg.append(path);
  $('message-icon').replaceChildren(svg);

  $('message-title').textContent = title;
  $('message-text').textContent = text;
  const actionsEl = $('message-actions');
  actionsEl.replaceChildren();
  let field = null;
  if (input) {
    field = h('input', { type: 'text', value: input.value || '', placeholder: input.placeholder || '', 'aria-label': input.label || title, autocomplete: 'off', spellcheck: 'false' });
    const form = h('form', { class: 'msg-form', onsubmit: (e) => { e.preventDefault(); input.onSubmit(field.value.trim()); } },
      field, h('button', { type: 'submit', class: 'btn primary' }, input.submit || 'Valider'));
    actionsEl.append(form);
  }
  for (const a of actions) {
    actionsEl.append(h('button', { type: 'button', class: `btn ${a.primary ? 'primary' : ''}`, onclick: a.onClick, id: a.id }, a.label));
  }
  message.hidden = false;
  (field || actionsEl.querySelector('button'))?.focus({ preventScroll: true });
}
export const hideMessage = () => (message.hidden = true);
export const messageVisible = () => !message.hidden;

const banner = $('banner');
export function showBanner(text, kind = 'warn') {
  if (!text) {
    banner.hidden = true;
    return;
  }
  banner.textContent = text;
  banner.dataset.kind = kind;
  banner.hidden = false;
}

export function setStatus(text, kind = 'ok') {
  const el = $('status');
  el.replaceChildren(h('i', { class: `dot ${kind}` }), h('span', {}, text));
}

export function toast(title, text, color) {
  const el = h('div', { class: 'toast', style: color ? { '--c': color } : {} }, h('strong', {}, title), h('span', {}, text));
  $('toasts').append(el);
  setTimeout(() => el.classList.add('out'), 4800);
  setTimeout(() => el.remove(), 5400);
}

export function setLoader(text) {
  const el = $('loader');
  if (text == null) {
    el.classList.add('done');
    setTimeout(() => (el.hidden = true), 700);
    return;
  }
  el.hidden = false;
  el.classList.remove('done');
  $('loader-text').textContent = text;
}
