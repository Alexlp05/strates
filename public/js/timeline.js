// La frise : un histogramme des écoutes dans le temps, chaque barre peinte
// avec les couleurs des pochettes écoutées à ce moment-là. On peut la
// parcourir (glisser) pour remonter le temps dans la ville.
// Les tranches sont comptées par le serveur (il a toutes les écoutes, la page
// n'a que les couches) ; sur un petit écran on fusionne les tranches voisines.

const DAY = 86400;
const yearFmt = new Intl.DateTimeFormat('fr-FR', { year: 'numeric' });
const monthOnlyFmt = new Intl.DateTimeFormat('fr-FR', { month: 'short' });
const dayFmt = new Intl.DateTimeFormat('fr-FR', { weekday: 'short', day: 'numeric' });
const monthFmt = new Intl.DateTimeFormat('fr-FR', { day: 'numeric', month: 'short' });
const hourFmt = new Intl.DateTimeFormat('fr-FR', { hour: '2-digit', minute: '2-digit' });

export class Timeline extends EventTarget {
  constructor(canvas, track) {
    super();
    this.canvas = canvas;
    this.track = track;
    this.ctx = canvas.getContext('2d');
    this.bins = [];
    this.cursor = Infinity;
    this.hoverBin = -1;
    this.domain = [0, 1];
    this.scrubbing = false;
    this.colorOf = () => '#888';

    track.tabIndex = 0;
    track.setAttribute('role', 'slider');
    track.setAttribute('aria-label', 'Parcourir le temps');

    new ResizeObserver(() => {
      this.resize();
      if (this.histogram && this._maxBins() !== this._lastMaxBins) this._buildBins();
    }).observe(track);

    track.addEventListener('pointerdown', (e) => {
      if (!this.bins.length) return;
      this.scrubbing = true;
      track.setPointerCapture(e.pointerId);
      this._emitScrub(e);
    });
    track.addEventListener('pointermove', (e) => {
      if (this.scrubbing) this._emitScrub(e);
      this._setHover(this._binAt(e.clientX));
    });
    const end = () => {
      if (!this.scrubbing) return;
      this.scrubbing = false;
      this.dispatchEvent(new CustomEvent('scrubend'));
    };
    track.addEventListener('pointerup', end);
    track.addEventListener('pointercancel', end);
    track.addEventListener('pointerleave', () => !this.scrubbing && this._setHover(-1));
    track.addEventListener('keydown', (e) => {
      if (!this.bins.length || !['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(e.key)) return;
      e.preventDefault();
      const [t0, t1] = this.domain;
      const cur = Number.isFinite(this.cursor) ? this.cursor : t1;
      let T = cur + (e.key === 'ArrowLeft' ? -1 : 1) * this.step;
      if (e.key === 'Home') T = t0;
      if (e.key === 'End') T = t1;
      T = Math.min(t1, Math.max(t0, T));
      this.dispatchEvent(new CustomEvent('scrub', { detail: { T } }));
      this.dispatchEvent(new CustomEvent('scrubend'));
    });
  }

  _timeAt(clientX) {
    const r = this.track.getBoundingClientRect();
    const f = Math.min(1, Math.max(0, (clientX - r.left) / r.width));
    return this.domain[0] + f * (this.domain[1] - this.domain[0]);
  }

  _binAt(clientX) {
    if (!this.bins.length) return -1;
    const r = this.track.getBoundingClientRect();
    const f = (clientX - r.left) / r.width;
    if (f < 0 || f > 1) return -1;
    return Math.min(this.bins.length - 1, Math.floor(f * this.bins.length));
  }

  _emitScrub(e) {
    this.dispatchEvent(new CustomEvent('scrub', { detail: { T: this._timeAt(e.clientX) } }));
  }

  _setHover(i) {
    if (i === this.hoverBin) return;
    this.hoverBin = i;
    this.draw();
    const bin = this.bins[i];
    this.dispatchEvent(new CustomEvent('hover', { detail: bin && bin.count ? { bin } : null }));
  }

  _maxBins() {
    return this.track.clientWidth < 520 ? 40 : 100;
  }

  // histogram = { t0, step, bins: [[total, [[albumId, n], …]], …] } (albumId "" = autres albums)
  setData({ histogram, domain, colorOf }) {
    this.domain = domain;
    this.colorOf = colorOf;
    this.histogram = histogram;
    this._buildBins();
    this.track.setAttribute('aria-valuemin', String(domain[0]));
    this.track.setAttribute('aria-valuemax', String(domain[1]));
  }

  _buildBins() {
    const { t0, step, bins } = this.histogram;
    const t1 = this.domain[1];
    this._lastMaxBins = this._maxBins();
    const k = Math.max(1, Math.ceil(bins.length / this._lastMaxBins)); // tranches fusionnées
    this.step = step * k;
    this.bins = [];
    for (let i = 0; i < bins.length; i += k) {
      const bin = { start: t0 + i * step, end: Math.min(t1, t0 + (i + k) * step), count: 0, albums: new Map() };
      for (const [total, parts] of bins.slice(i, i + k)) {
        bin.count += total;
        for (const [id, c] of parts) bin.albums.set(id, (bin.albums.get(id) || 0) + c);
      }
      this.bins.push(bin);
    }
    this.maxCount = Math.max(1, ...this.bins.map((b) => b.count));
    this.draw();
  }

  setCursor(T) {
    this.cursor = T;
    this.track.setAttribute('aria-valuenow', String(Number.isFinite(T) ? Math.round(T) : this.domain[1]));
    this.draw();
  }

  resize() {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const w = this.track.clientWidth;
    const h = this.track.clientHeight;
    this.canvas.width = Math.round(w * dpr);
    this.canvas.height = Math.round(h * dpr);
    this.canvas.style.width = `${w}px`;
    this.canvas.style.height = `${h}px`;
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.draw();
  }

  draw() {
    const ctx = this.ctx;
    const w = this.track.clientWidth;
    const h = this.track.clientHeight;
    ctx.clearRect(0, 0, w, h);
    if (!this.bins.length) return;

    const [t0, t1] = this.domain;
    const span = Math.max(1, t1 - t0);
    const labelH = 15;
    const barArea = h - labelH - 2;
    const n = this.bins.length;
    const bw = w / n;
    const gap = bw > 6 ? 1.5 : 0.5;
    const xOf = (t) => ((t - t0) / span) * w;

    // repères de jours / d'heures
    ctx.font = '500 10px system-ui, -apple-system, Segoe UI, sans-serif';
    ctx.textBaseline = 'bottom';
    const ticks = this._ticks(t0, t1);
    let lastLabelX = -Infinity;
    for (const tick of ticks) {
      const x = xOf(tick.t);
      ctx.fillStyle = 'rgba(255,255,255,0.07)';
      ctx.fillRect(Math.round(x), 0, 1, barArea);
      if (x - lastLabelX > 46 && x < w - 20) {
        ctx.fillStyle = 'rgba(255,255,255,0.42)';
        ctx.fillText(tick.label, x + 3, h);
        lastLabelX = x;
      }
    }

    // barres empilées, une couleur par album
    const cursor = this.cursor;
    for (let i = 0; i < n; i++) {
      const bin = this.bins[i];
      const x = i * bw;
      if (i === this.hoverBin) {
        ctx.fillStyle = 'rgba(255,255,255,0.08)';
        ctx.fillRect(x, 0, bw, barArea);
      }
      if (!bin.count) {
        ctx.fillStyle = 'rgba(255,255,255,0.10)';
        ctx.fillRect(x + gap / 2, barArea - 1, Math.max(1, bw - gap), 1);
        continue;
      }
      const past = !Number.isFinite(cursor) || bin.end <= cursor;
      const partial = Number.isFinite(cursor) && bin.start < cursor && bin.end > cursor;
      ctx.globalAlpha = past ? 1 : partial ? 0.65 : 0.2;
      const total = (bin.count / this.maxCount) * (barArea - 4);
      let y = barArea;
      const segments = [...bin.albums.entries()].sort((a, b) => b[1] - a[1]);
      for (const [albumId, c] of segments) {
        const sh = (c / bin.count) * total;
        ctx.fillStyle = albumId ? this.colorOf(albumId) : 'rgba(255,255,255,0.22)';
        ctx.fillRect(x + gap / 2, y - sh, Math.max(1, bw - gap), Math.max(0.6, sh - 0.4));
        y -= sh;
      }
      ctx.globalAlpha = 1;
    }

    // curseur
    if (Number.isFinite(cursor)) {
      const x = Math.min(w - 1, Math.max(1, xOf(cursor)));
      ctx.fillStyle = 'rgba(255,255,255,0.95)';
      ctx.fillRect(x - 1, 0, 2, barArea);
      ctx.beginPath();
      ctx.arc(x, 4, 4, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  _ticks(t0, t1) {
    const span = t1 - t0;
    const out = [];
    if (span <= 2 * 86400) {
      const every = span <= 30 * 3600 ? 3 * 3600 : 6 * 3600;
      const d = new Date(t0 * 1000);
      d.setMinutes(0, 0, 0);
      let t = d.getTime() / 1000;
      while (t < t1) {
        t += 3600;
        const hd = new Date(t * 1000);
        if (hd.getHours() % (every / 3600) === 0 && t > t0) {
          out.push({ t, label: hd.getHours() === 0 ? dayFmt.format(hd) : hourFmt.format(hd) });
        }
      }
      return out;
    }
    // plusieurs mois : un repère par mois (ou par trimestre), plusieurs années : par an
    if (span > 120 * DAY) {
      const years = span / (365 * DAY);
      const everyMonths = years > 4 ? 12 : years > 1.6 ? 3 : 1;
      const d = new Date(t0 * 1000);
      d.setDate(1);
      d.setHours(0, 0, 0, 0);
      for (;;) {
        d.setMonth(d.getMonth() + 1);
        const t = d.getTime() / 1000;
        if (t >= t1) break;
        if (d.getMonth() % everyMonths) continue;
        out.push({ t, label: d.getMonth() === 0 ? yearFmt.format(d) : monthOnlyFmt.format(d) });
      }
      return out;
    }
    const d = new Date(t0 * 1000);
    d.setHours(24, 0, 0, 0);
    const days = span / 86400;
    const everyDays = days > 45 ? 7 : days > 14 ? 3 : 1;
    let k = 0;
    for (let t = d.getTime() / 1000; t < t1; t += 86400, k++) {
      if (k % everyDays) continue;
      const day = new Date(t * 1000);
      out.push({ t, label: days > 14 ? monthFmt.format(day) : dayFmt.format(day) });
    }
    return out;
  }
}
