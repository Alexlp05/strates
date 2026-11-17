// La ville 3D.
//
// Un album = une tour posée sur une case de la carte.
// Une écoute = une couche (une dalle) de la tour : on peut compter les écoutes.
// La pochette sert de toit ; elle se soulève et se tourne vers toi quand une
// nouvelle couche tombe dessous, quand tu la survoles ou quand tu la choisis.
// Les albums les plus écoutés sont au centre, les albums d'un même artiste
// forment un quartier. Les couches récentes brillent, les anciennes s'éteignent.

import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';

const CELL = 1.7; // distance entre deux tours
const COVER = 1.06; // taille d'une pochette
const MAX_SLABS = 3400;
const MAX_PILES = 2600;
const MAX_DISTRICTS = 1300;
const TARGET_HEIGHT = 5.2; // hauteur de la tour la plus haute
const SHADES = [1, 0.72, 1.24, 0.86, 0.6, 1.12, 0.8, 1.34]; // un ton par morceau
const RIPPLE_SPEED = 6;

const UP = new THREE.Vector3(0, 1, 0);
const FLAT_Q = new THREE.Quaternion().setFromEuler(new THREE.Euler(-Math.PI / 2, 0, 0));
const ID_Q = new THREE.Quaternion();
const _m = new THREE.Matrix4();
const _p = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _s = new THREE.Vector3();
const _v = new THREE.Vector3();
const _c = new THREE.Color();

const { damp, clamp, lerp } = THREE.MathUtils;
const easeOutCubic = (t) => 1 - (1 - t) ** 3;
const easeInOutCubic = (t) => (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2);
function easeOutBounce(t) {
  const n = 7.5625, d = 2.75;
  if (t < 1 / d) return n * t * t;
  if (t < 2 / d) return n * (t -= 1.5 / d) * t + 0.75;
  if (t < 2.5 / d) return n * (t -= 2.25 / d) * t + 0.9375;
  return n * (t -= 2.625 / d) * t + 0.984375;
}
const rand = (seed) => {
  const x = Math.sin(seed * 12.9898) * 43758.5453;
  return x - Math.floor(x);
};

// Cases de la grille, du centre vers l'extérieur, anneau par anneau, dans le
// sens des aiguilles d'une montre.
function spiralCells(n) {
  const k = Math.ceil(Math.sqrt(n) / 2) + 3;
  const cells = [];
  for (let i = -k; i <= k; i++) {
    for (let j = -k; j <= k; j++) {
      const ring = Math.round(Math.hypot(i, j));
      const a = (Math.atan2(j, i) + Math.PI * 2.25) % (Math.PI * 2);
      cells.push({ i, j, ring, a });
    }
  }
  cells.sort((p, q) => p.ring - q.ring || p.a - q.a);
  return cells.slice(0, n);
}

// Les quartiers. Les albums d'un même artiste forment un bloc compact
// (le plus écouté du côté du centre-ville) et deux quartiers sont toujours
// séparés par une rue d'une case. Les gros artistes sont posés en premier,
// donc au centre ; les artistes d'un seul album remplissent les trous, en
// banlieue. Grille : 0 = libre, 1 = bâtiment, 2 = rue.
function districtLayout(albums, artists) {
  const rank = new Map(artists.map((a, i) => [a.name.toLowerCase(), i]));
  const groups = new Map();
  for (const album of albums) {
    const key = album.artist.toLowerCase();
    if (!groups.has(key)) groups.set(key, { key, name: album.artist, albums: [], plays: 0 });
    const g = groups.get(key);
    g.albums.push(album);
    g.plays += album.plays;
  }
  const ordered = [...groups.values()].sort((a, b) => (rank.get(a.key) ?? 1e9) - (rank.get(b.key) ?? 1e9) || b.plays - a.plays);

  const grid = new Map();
  const at = (i, j) => grid.get(`${i},${j}`) || 0;
  const fits = (i0, j0, w, h, isDistrict) => {
    for (let i = i0 - 1; i <= i0 + w; i++) {
      for (let j = j0 - 1; j <= j0 + h; j++) {
        const inside = i >= i0 && i < i0 + w && j >= j0 && j < j0 + h;
        const v = at(i, j);
        if (inside ? v !== 0 : isDistrict && v === 1) return false;
      }
    }
    return true;
  };

  let spiral = spiralCells(Math.ceil(albums.length * 3.2) + 64);
  let start = 0;
  const cellOf = new Map();
  const districts = [];
  for (const g of ordered) {
    g.albums.sort((a, b) => b.plays - a.plays || (b.last || 0) - (a.last || 0));
    const n = g.albums.length;
    const w = Math.ceil(Math.sqrt(n));
    const h = Math.ceil(n / w);
    const isDistrict = n > 1;
    while (start < spiral.length && at(spiral[start].i, spiral[start].j)) start++;
    let spot = null;
    while (!spot) {
      for (let s = start; s < spiral.length && !spot; s++) {
        const i0 = spiral[s].i - Math.floor((w - 1) / 2);
        const j0 = spiral[s].j - Math.floor((h - 1) / 2);
        if (fits(i0, j0, w, h, isDistrict)) spot = { i0, j0 };
      }
      if (!spot) spiral = spiralCells(spiral.length * 2); // ville plus grande que prévu
    }
    const cells = [];
    for (let i = spot.i0 - 1; i <= spot.i0 + w; i++) {
      for (let j = spot.j0 - 1; j <= spot.j0 + h; j++) {
        const inside = i >= spot.i0 && i < spot.i0 + w && j >= spot.j0 && j < spot.j0 + h;
        if (inside) {
          grid.set(`${i},${j}`, 1);
          cells.push({ i, j });
        } else if (isDistrict && !at(i, j)) grid.set(`${i},${j}`, 2);
      }
    }
    // la tour la plus haute du quartier regarde le centre-ville
    cells.sort((a, b) => a.i * a.i + a.j * a.j - (b.i * b.i + b.j * b.j));
    g.albums.forEach((album, k) => cellOf.set(album.id, cells[k]));
    if (isDistrict) districts.push({ key: g.key, name: g.name, plays: g.plays, albumIds: g.albums.map((a) => a.id) });
  }
  return { cellOf, districts };
}

// Le sol d'un quartier : un plan arrondi, contour fin aux coins marqués,
// hachures très légères, à la couleur de son album le plus écouté.
const PLATE_VS = /* glsl */ `
attribute vec3 aColor;
attribute vec2 aSize;
attribute float aHi;
varying vec2 vP;
varying vec2 vHalf;
varying vec3 vColor;
varying float vHi;
varying vec3 vWorld;
void main() {
  vec4 w = modelMatrix * instanceMatrix * vec4(position, 1.0);
  vWorld = w.xyz;
  vP = (uv - 0.5) * aSize;
  vHalf = aSize * 0.5;
  vColor = aColor;
  vHi = aHi;
  gl_Position = projectionMatrix * viewMatrix * w;
}`;

const PLATE_FS = /* glsl */ `
uniform float uFogDensity;
uniform float uBoost;
varying vec2 vP;
varying vec2 vHalf;
varying vec3 vColor;
varying float vHi;
varying vec3 vWorld;

float sdRoundBox(vec2 p, vec2 b, float r) {
  vec2 q = abs(p) - b + r;
  return length(max(q, 0.0)) + min(max(q.x, q.y), 0.0) - r;
}

void main() {
  vec2 inner = vHalf - 0.07;
  float d = sdRoundBox(vP, inner, 0.3); // < 0 dans le quartier
  float fw = fwidth(d);
  float inside = 1.0 - smoothstep(-fw, fw, d);
  float edge = 1.0 - smoothstep(0.014, 0.014 + fw * 1.5, abs(d));
  float rim = inside * exp(d * 2.6);
  // coins renforcés, comme les repères d'un plan d'urbanisme
  vec2 a = abs(vP) - inner;
  float corner = smoothstep(-0.75, -0.45, a.x) * smoothstep(-0.75, -0.45, a.y);
  // hachures diagonales
  float hs = (vP.x + vP.y) * 3.2;
  float hatch = inside * (1.0 - smoothstep(0.05, 0.05 + fwidth(hs) * 1.5, abs(fract(hs) - 0.5)));

  float k = edge * (0.26 + corner * 0.5 + vHi * 0.85)
          + rim * (0.08 + vHi * 0.22)
          + hatch * (0.045 + vHi * 0.07)
          + inside * (0.02 + vHi * 0.04);
  float dist = length(vWorld - cameraPosition);
  float fog = exp(-uFogDensity * uFogDensity * dist * dist);
  gl_FragColor = vec4(vColor * k * uBoost * fog, 1.0);
}`;

function glowTexture() {
  const size = 128;
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext('2d');
  const g = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  g.addColorStop(0, 'rgba(255,255,255,1)');
  g.addColorStop(0.35, 'rgba(255,255,255,0.55)');
  g.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, size, size);
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

// ---------------------------------------------------------------- shaders

const SKY_VS = /* glsl */ `
varying vec3 vDir;
void main() {
  vDir = normalize(position);
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}`;

const SKY_FS = /* glsl */ `
uniform vec3 uTop;
uniform vec3 uFog;
uniform vec3 uGlow;
uniform vec3 uAccent;
uniform float uTime;
varying vec3 vDir;
void main() {
  float y = vDir.y;
  float ang = atan(vDir.z, vDir.x);
  vec3 col = mix(uFog, uTop, smoothstep(0.0, 0.6, y));
  col += uGlow * exp(-max(y, 0.0) * 9.0) * 0.9;
  // voile coloré par les pochettes, qui ondule lentement
  float band = 0.16 + 0.05 * sin(ang * 3.0 + uTime * 0.05) + 0.03 * sin(ang * 7.0 - uTime * 0.08);
  float aurora = exp(-pow((y - band) * 9.0, 2.0)) * (0.55 + 0.45 * sin(ang * 5.0 + uTime * 0.1));
  col += uAccent * aurora * 0.55 * smoothstep(-0.02, 0.05, y);
  col = mix(col, uFog, smoothstep(0.02, -0.1, y));
  gl_FragColor = vec4(col, 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}`;

const STARS_VS = /* glsl */ `
attribute float aSize;
attribute float aPhase;
uniform float uTime;
uniform float uPixelRatio;
varying float vAlpha;
void main() {
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  gl_Position = projectionMatrix * mv;
  gl_PointSize = aSize * uPixelRatio;
  vAlpha = 0.45 + 0.55 * sin(uTime * (0.6 + fract(aPhase) * 1.6) + aPhase * 6.2831);
}`;

const STARS_FS = /* glsl */ `
varying float vAlpha;
void main() {
  float d = length(gl_PointCoord - 0.5);
  float a = smoothstep(0.5, 0.0, d) * vAlpha;
  gl_FragColor = vec4(vec3(0.85, 0.88, 1.0), a);
  #include <colorspace_fragment>
}`;

const GROUND_VS = /* glsl */ `
varying vec3 vWorld;
void main() {
  vec4 w = modelMatrix * vec4(position, 1.0);
  vWorld = w.xyz;
  gl_Position = projectionMatrix * viewMatrix * w;
}`;

const GROUND_FS = /* glsl */ `
uniform float uTime;
uniform float uCell;
uniform float uRadius;
uniform float uFogDensity;
uniform vec3 uBase;
uniform vec3 uLine;
uniform vec3 uFog;
uniform vec4 uRipples[4];
varying vec3 vWorld;

float street(float coord, float width) {
  float d = abs(fract(coord) - 0.5);
  float fw = fwidth(coord);
  return 1.0 - smoothstep(width, width + fw * 1.5, d);
}

void main() {
  vec2 p = vWorld.xz;
  vec2 c = p / uCell;
  float lx = street(c.x, 0.006);
  float lz = street(c.y, 0.006);
  float grid = max(lx, lz);
  float xing = lx * lz;
  float r = length(p);
  float fade = 1.0 - smoothstep(uRadius * 0.9, uRadius * 2.4, r);

  // balayage radar autour de la ville
  float ang = atan(p.y, p.x);
  float diff = mod(mod(uTime * 0.35, 6.2831853) - ang + 6.2831853, 6.2831853);
  float sweep = exp(-diff * 2.2) * (1.0 - smoothstep(uRadius * 0.5, uRadius * 2.2, r));

  // ondes lancées par les nouvelles écoutes
  float ring = 0.0;
  for (int i = 0; i < 4; i++) {
    vec4 rp = uRipples[i];
    float age = uTime - rp.z;
    if (age < 0.0 || age > 6.0) continue;
    float d = length(p - rp.xy) - age * ${RIPPLE_SPEED.toFixed(1)};
    ring += exp(-d * d * 1.5) * exp(-age * 0.7) * rp.w;
  }

  // cercles de distance, comme sur une carte
  float rc = r / (uCell * 4.0);
  float contour = 1.0 - smoothstep(0.0, fwidth(rc) * 1.5, abs(fract(rc + 0.5) - 0.5));
  contour *= step(0.6, rc) * (0.5 + 0.5 * step(0.5, fract(ang * 12.0 / 6.2831853)));

  vec3 col = uBase;
  col += uLine * grid * (0.1 + sweep * 0.7 + ring * 1.4) * fade;
  col += uLine * xing * 0.4 * fade;
  col += uLine * contour * 0.12 * fade;
  col += uLine * (sweep * 0.05 + ring * 0.08) * fade;

  float dist = length(vWorld - cameraPosition);
  float f = 1.0 - exp(-uFogDensity * uFogDensity * dist * dist);
  col = mix(col, uFog, clamp(f, 0.0, 1.0));
  gl_FragColor = vec4(col, 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}`;

const BEAM_VS = /* glsl */ `
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}`;

const BEAM_FS = /* glsl */ `
uniform vec3 uColor;
uniform float uTime;
varying vec2 vUv;
void main() {
  float a = pow(1.0 - vUv.y, 2.2) * (0.55 + 0.45 * sin(uTime * 3.0 - vUv.y * 40.0));
  a *= 0.55 + 0.45 * pow(abs(sin(vUv.x * 3.14159 * 2.0)), 0.5);
  gl_FragColor = vec4(uColor * 1.6, a * 0.6);
  #include <colorspace_fragment>
}`;

const DUST_VS = /* glsl */ `
attribute vec3 aColor;
attribute float aSpeed;
attribute float aPhase;
attribute float aSize;
uniform float uTime;
uniform float uHeight;
uniform float uPixelRatio;
varying vec3 vColor;
varying float vAlpha;
void main() {
  vec3 p = position;
  p.y = mod(p.y + uTime * aSpeed, uHeight);
  p.x += sin(uTime * 0.3 + aPhase) * 0.5;
  p.z += cos(uTime * 0.23 + aPhase * 1.7) * 0.5;
  vec4 mv = modelViewMatrix * vec4(p, 1.0);
  gl_Position = projectionMatrix * mv;
  gl_PointSize = min(aSize * uPixelRatio * (14.0 / -mv.z), 48.0);
  vAlpha = smoothstep(0.0, 1.5, p.y) * (1.0 - smoothstep(uHeight * 0.55, uHeight, p.y));
  vColor = aColor;
}`;

const DUST_FS = /* glsl */ `
varying vec3 vColor;
varying float vAlpha;
void main() {
  float d = length(gl_PointCoord - 0.5);
  float a = smoothstep(0.5, 0.0, d) * vAlpha;
  gl_FragColor = vec4(vColor * 1.4, a * 0.8);
  #include <colorspace_fragment>
}`;

// ---------------------------------------------------------------- la ville

export class City extends EventTarget {
  constructor(container, { labels, lowPower = false, reducedMotion = false } = {}) {
    super();
    this.container = container;
    this.labelsEl = labels;
    this.lowPower = lowPower;
    this.reducedMotion = reducedMotion;

    this.piles = new Map();
    this.slabs = [];
    this.instanceSlabs = [];
    this.cursor = Infinity;
    this.domain = [0, 1];
    this.radius = 6;
    this.maxPlays = 1;
    this.slabH = 0.22;
    this.step = 0.28;
    this.dropTime = reducedMotion ? 0.35 : 0.75;
    this.view = 'city';
    this.focused = null;
    this.hovered = null;
    this.highlightSet = null;
    this.nowPlayingId = null;
    this.ripples = [];
    this.flight = null;
    this.lastInteraction = -Infinity;
    this.labels = [];
    this.time = 0;
    this.lastFrame = performance.now();
    this.raycaster = new THREE.Raycaster();
    this.pointer = { downX: 0, downY: 0, downT: 0 };
    this.viewShift = 0;

    this._initRenderer();
    this._initWorld();
    this._initEvents();
  }

  // ------------------------------------------------------------ mise en place

  _initRenderer() {
    const r = (this.renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' }));
    r.setPixelRatio(Math.min(window.devicePixelRatio || 1, this.lowPower ? 1.5 : 2));
    r.toneMapping = THREE.NeutralToneMapping;
    r.toneMappingExposure = 1.0;
    r.shadowMap.enabled = !this.lowPower;
    r.shadowMap.type = THREE.PCFShadowMap;
    this.container.appendChild(r.domElement);

    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(45, 1, 0.1, 1500);
    this.camera.position.set(0, 40, 1);

    const c = (this.controls = new OrbitControls(this.camera, r.domElement));
    c.enableDamping = true;
    c.dampingFactor = 0.07;
    c.maxPolarAngle = 1.42;
    c.minDistance = 2.5;
    c.maxDistance = 140;
    c.screenSpacePanning = false;
    c.autoRotate = !this.reducedMotion;
    c.autoRotateSpeed = 0.35;
    c.addEventListener('start', () => {
      this.flight = null;
      this.lastInteraction = this.time;
      c.autoRotate = false;
    });
    c.addEventListener('end', () => (this.lastInteraction = this.time));

    const pmrem = new THREE.PMREMGenerator(r);
    this.scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
    this.scene.environmentIntensity = 0.28;
    pmrem.dispose();

    if (!this.lowPower) {
      const target = new THREE.WebGLRenderTarget(1, 1, { type: THREE.HalfFloatType, samples: 4 });
      this.composer = new EffectComposer(r, target);
      this.composer.addPass(new RenderPass(this.scene, this.camera));
      this.bloom = new UnrealBloomPass(new THREE.Vector2(1, 1), 0.7, 0.5, 0.92);
      this.composer.addPass(this.bloom);
      this.composer.addPass(new OutputPass());
    }

    new ResizeObserver(() => this.resize()).observe(this.container);
    this.resize();
  }

  _initWorld() {
    const scene = this.scene;
    this.glowTex = glowTexture();

    const P = (hex) => new THREE.Color(hex);
    this.palette = { fog: P('#0a0816'), top: P('#020207'), glow: P('#2a1748'), accent: P('#1d3f72'), line: P('#6f62b0'), base: P('#06050c') };
    this.paletteTarget = Object.fromEntries(Object.entries(this.palette).map(([k, v]) => [k, v.clone()]));

    scene.fog = new THREE.FogExp2(this.palette.fog.clone(), 0.02);
    scene.background = this.palette.fog.clone();

    // Ciel + étoiles (suivent la caméra)
    this.sky = new THREE.Group();
    this.skyMat = new THREE.ShaderMaterial({
      side: THREE.BackSide,
      depthWrite: false,
      uniforms: {
        uTop: { value: this.palette.top },
        uFog: { value: this.palette.fog },
        uGlow: { value: this.palette.glow },
        uAccent: { value: this.palette.accent },
        uTime: { value: 0 },
      },
      vertexShader: SKY_VS,
      fragmentShader: SKY_FS,
    });
    const skyMesh = new THREE.Mesh(new THREE.SphereGeometry(700, 48, 24), this.skyMat);
    skyMesh.renderOrder = -10;
    skyMesh.frustumCulled = false;
    this.sky.add(skyMesh);

    const starCount = this.lowPower ? 600 : 1400;
    const starPos = new Float32Array(starCount * 3);
    const starSize = new Float32Array(starCount);
    const starPhase = new Float32Array(starCount);
    for (let i = 0; i < starCount; i++) {
      const u = rand(i + 1), v = rand(i + 7.3);
      const theta = u * Math.PI * 2;
      const y = 0.04 + v * 0.96;
      const rr = Math.sqrt(1 - y * y);
      starPos.set([Math.cos(theta) * rr * 600, y * 600, Math.sin(theta) * rr * 600], i * 3);
      starSize[i] = 0.8 + rand(i + 3.1) ** 3 * 2.6;
      starPhase[i] = rand(i + 9.9);
    }
    const starGeo = new THREE.BufferGeometry();
    starGeo.setAttribute('position', new THREE.BufferAttribute(starPos, 3));
    starGeo.setAttribute('aSize', new THREE.BufferAttribute(starSize, 1));
    starGeo.setAttribute('aPhase', new THREE.BufferAttribute(starPhase, 1));
    this.starMat = new THREE.ShaderMaterial({
      uniforms: { uTime: { value: 0 }, uPixelRatio: { value: this.renderer.getPixelRatio() } },
      vertexShader: STARS_VS,
      fragmentShader: STARS_FS,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
    const stars = new THREE.Points(starGeo, this.starMat);
    stars.frustumCulled = false;
    this.sky.add(stars);
    scene.add(this.sky);

    // Sol : la carte (rues, cercles de distance, balayage radar, ondes)
    this.groundMat = new THREE.ShaderMaterial({
      uniforms: {
        uTime: { value: 0 },
        uCell: { value: CELL },
        uRadius: { value: 8 },
        uFogDensity: { value: 0.02 },
        uBase: { value: this.palette.base },
        uLine: { value: this.palette.line },
        uFog: { value: this.palette.fog },
        uRipples: { value: Array.from({ length: 4 }, () => new THREE.Vector4(0, 0, -100, 0)) },
      },
      vertexShader: GROUND_VS,
      fragmentShader: GROUND_FS,
    });
    const ground = new THREE.Mesh(new THREE.PlaneGeometry(1400, 1400).rotateX(-Math.PI / 2), this.groundMat);
    scene.add(ground);

    if (this.renderer.shadowMap.enabled) {
      this.shadowPlane = new THREE.Mesh(
        new THREE.PlaneGeometry(120, 120).rotateX(-Math.PI / 2),
        new THREE.ShadowMaterial({ opacity: 0.5, color: 0x000000 }),
      );
      this.shadowPlane.position.y = 0.004;
      this.shadowPlane.receiveShadow = true;
      scene.add(this.shadowPlane);
    }

    // Halo coloré sous chaque tour : vue d'en haut, une carte de chaleur
    this.footprints = new THREE.InstancedMesh(
      new THREE.PlaneGeometry(CELL * 1.3, CELL * 1.3).rotateX(-Math.PI / 2),
      new THREE.MeshBasicMaterial({ map: this.glowTex, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false, fog: false }),
      MAX_PILES,
    );
    this.footprints.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(MAX_PILES * 3), 3);
    this.footprints.count = 0;
    this.footprints.frustumCulled = false;
    this.footprints.renderOrder = 1;
    scene.add(this.footprints);

    // Le sol des quartiers (un plan par artiste de plusieurs albums)
    const plateGeo = new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2);
    this.plateColor = new THREE.InstancedBufferAttribute(new Float32Array(MAX_DISTRICTS * 3), 3).setUsage(THREE.DynamicDrawUsage);
    this.plateSize = new THREE.InstancedBufferAttribute(new Float32Array(MAX_DISTRICTS * 2), 2).setUsage(THREE.DynamicDrawUsage);
    this.plateHi = new THREE.InstancedBufferAttribute(new Float32Array(MAX_DISTRICTS), 1).setUsage(THREE.DynamicDrawUsage);
    plateGeo.setAttribute('aColor', this.plateColor);
    plateGeo.setAttribute('aSize', this.plateSize);
    plateGeo.setAttribute('aHi', this.plateHi);
    this.plateMat = new THREE.ShaderMaterial({
      vertexShader: PLATE_VS,
      fragmentShader: PLATE_FS,
      uniforms: { uFogDensity: { value: 0.02 }, uBoost: { value: 1 } },
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      toneMapped: false,
    });
    this.plates = new THREE.InstancedMesh(plateGeo, this.plateMat, MAX_DISTRICTS);
    this.plates.count = 0;
    this.plates.frustumCulled = false;
    this.plates.renderOrder = 1;
    scene.add(this.plates);
    this.districts = [];

    // Les couches (une par écoute), toutes dans un seul InstancedMesh
    this.glowAttr = new THREE.InstancedBufferAttribute(new Float32Array(MAX_SLABS * 3), 3);
    this.glowAttr.setUsage(THREE.DynamicDrawUsage);
    const slabMat = new THREE.MeshStandardMaterial({ roughness: 0.32, metalness: 0.12 });
    slabMat.onBeforeCompile = (shader) => {
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', '#include <common>\nattribute vec3 aGlow;\nvarying vec3 vGlow;')
        .replace('#include <begin_vertex>', '#include <begin_vertex>\nvGlow = aGlow;');
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', '#include <common>\nvarying vec3 vGlow;')
        .replace('#include <emissivemap_fragment>', '#include <emissivemap_fragment>\ntotalEmissiveRadiance += vGlow;');
    };
    this.slabMesh = new THREE.InstancedMesh(this._slabGeometry(this.slabH), slabMat, MAX_SLABS);
    this.slabMesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(MAX_SLABS * 3), 3);
    this.slabMesh.instanceColor.setUsage(THREE.DynamicDrawUsage);
    this.slabMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.slabMesh.count = 0;
    this.slabMesh.castShadow = true;
    this.slabMesh.receiveShadow = true;
    this.slabMesh.frustumCulled = false;
    this.slabMesh.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 500);
    scene.add(this.slabMesh);

    this.coverGeo = new THREE.PlaneGeometry(COVER, COVER);
    this.haloGeo = new THREE.PlaneGeometry(COVER * 1.7, COVER * 1.7);

    // Lumières
    this.hemi = new THREE.HemisphereLight(0x9b8cff, 0x0b0812, 0.9);
    scene.add(this.hemi);
    this.moon = new THREE.DirectionalLight(0xdfe4ff, 1.6);
    this.moon.position.set(9, 16, 6);
    this.moon.castShadow = this.renderer.shadowMap.enabled;
    this.moon.shadow.mapSize.set(2048, 2048);
    this.moon.shadow.bias = -0.0004;
    this.moon.shadow.normalBias = 0.03;
    scene.add(this.moon, this.moon.target);

    // « En écoute » : une couche fantôme qui pulse + un faisceau vers le ciel
    this.np = new THREE.Group();
    this.npGhost = new THREE.Mesh(
      new THREE.BoxGeometry(1, 1, 1),
      new THREE.MeshBasicMaterial({ transparent: true, opacity: 0.5, blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false }),
    );
    this.npBeamMat = new THREE.ShaderMaterial({
      uniforms: { uColor: { value: new THREE.Color() }, uTime: { value: 0 } },
      vertexShader: BEAM_VS,
      fragmentShader: BEAM_FS,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      side: THREE.DoubleSide,
    });
    this.npBeam = new THREE.Mesh(new THREE.CylinderGeometry(0.62, 0.62, 1, 40, 1, true).translate(0, 0.5, 0), this.npBeamMat);
    this.npLight = new THREE.PointLight(0xffffff, 18, 9, 1.6);
    this.np.add(this.npGhost, this.npBeam, this.npLight);
    this.np.visible = false;
    scene.add(this.np);

    // Poussière colorée par les pochettes
    const dustCount = this.lowPower ? 160 : 420;
    const dustGeo = new THREE.BufferGeometry();
    const pos = new Float32Array(dustCount * 3);
    const speed = new Float32Array(dustCount);
    const phase = new Float32Array(dustCount);
    const size = new Float32Array(dustCount);
    for (let i = 0; i < dustCount; i++) {
      const a = rand(i + 0.5) * Math.PI * 2;
      const rr = Math.sqrt(rand(i + 2.2));
      pos.set([Math.cos(a) * rr, rand(i + 4.4) * 9, Math.sin(a) * rr], i * 3);
      speed[i] = 0.12 + rand(i + 5.5) * 0.35;
      phase[i] = rand(i + 6.6) * 10;
      size[i] = 1.5 + rand(i + 8.8) * 3;
    }
    this.dustUnit = pos.slice();
    dustGeo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    dustGeo.setAttribute('aColor', new THREE.BufferAttribute(new Float32Array(dustCount * 3).fill(0.6), 3));
    dustGeo.setAttribute('aSpeed', new THREE.BufferAttribute(speed, 1));
    dustGeo.setAttribute('aPhase', new THREE.BufferAttribute(phase, 1));
    dustGeo.setAttribute('aSize', new THREE.BufferAttribute(size, 1));
    this.dustMat = new THREE.ShaderMaterial({
      uniforms: { uTime: { value: 0 }, uHeight: { value: 9 }, uPixelRatio: { value: this.renderer.getPixelRatio() } },
      vertexShader: DUST_VS,
      fragmentShader: DUST_FS,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
    this.dust = new THREE.Points(dustGeo, this.dustMat);
    this.dust.frustumCulled = false;
    scene.add(this.dust);
  }

  _slabGeometry(h) {
    const geo = new RoundedBoxGeometry(1, h, 1, 2, Math.min(0.05, h * 0.3));
    geo.setAttribute('aGlow', this.glowAttr);
    return geo;
  }

  _initEvents() {
    const el = this.renderer.domElement;
    el.addEventListener('pointermove', (e) => {
      if (e.pointerType === 'mouse') this._setHover(this._hit(e), e);
    });
    el.addEventListener('pointerleave', () => this._setHover(null));
    el.addEventListener('pointerdown', (e) => {
      this.pointer.downX = e.clientX;
      this.pointer.downY = e.clientY;
      this.pointer.downT = performance.now();
    });
    el.addEventListener('pointerup', (e) => {
      const moved = Math.hypot(e.clientX - this.pointer.downX, e.clientY - this.pointer.downY);
      if (moved > 8 || performance.now() - this.pointer.downT > 600) return;
      const hit = this._hit(e);
      if (hit) this.focus(hit.pile);
      else if (this.focused) this.clearFocus();
    });
    el.addEventListener('dblclick', (e) => {
      if (!this._hit(e)) this.resetView();
    });
  }

  _hit(e) {
    const rect = this.renderer.domElement.getBoundingClientRect();
    const ndc = new THREE.Vector2(((e.clientX - rect.left) / rect.width) * 2 - 1, -((e.clientY - rect.top) / rect.height) * 2 + 1);
    this.raycaster.setFromCamera(ndc, this.camera);
    const covers = [];
    for (const p of this.piles.values()) if (p.cover.visible && p.presence > 0.3) covers.push(p.cover);
    const hits = this.raycaster.intersectObjects([this.slabMesh, ...covers], false);
    for (const h of hits) {
      if (h.object === this.slabMesh) {
        const s = this.instanceSlabs[h.instanceId];
        if (s && s.t > 0.5 && s.pile.alive) return { pile: s.pile, slab: s };
      } else {
        const p = h.object.userData.pile;
        if (p?.alive) return { pile: p, slab: null };
      }
    }
    return null;
  }

  _setHover(hit, e) {
    const same = hit?.pile === this.hovered?.pile && hit?.slab === this.hovered?.slab;
    this.hovered = hit;
    this.renderer.domElement.style.cursor = hit ? 'pointer' : '';
    if (!same || hit) {
      this.dispatchEvent(new CustomEvent('hover', { detail: hit ? { ...hit, x: e.clientX, y: e.clientY } : null }));
    }
  }

  resize() {
    const w = this.container.clientWidth || window.innerWidth;
    const h = this.container.clientHeight || window.innerHeight;
    this.renderer.setSize(w, h);
    this.camera.aspect = w / h;
    this.camera.fov = w / h < 0.8 ? 55 : 45;
    this.camera.updateProjectionMatrix();
    if (this.composer) {
      this.composer.setPixelRatio(this.renderer.getPixelRatio());
      this.composer.setSize(w, h);
    }
  }

  // ------------------------------------------------------------ données

  // Réconcilie la ville avec de nouvelles données : les tours existantes
  // glissent vers leur nouvelle case, les nouvelles poussent, les anciennes
  // disparaissent. Les couches déjà posées restent posées.
  setData(data, covers, { domain }) {
    this.data = data;
    this.domain = domain;
    this.nowPlayingId = data.nowPlaying?.albumId || null;

    const { cellOf, districts } = districtLayout(data.albums, data.artists);
    const shadows = this.renderer.shadowMap.enabled;

    const seen = new Set();
    let radius = CELL;
    data.albums.forEach((album, rank) => {
      const cell = cellOf.get(album.id);
      let pile = this.piles.get(album.id);
      const info = covers.get(album.id);
      if (!pile) {
        pile = this._createPile(album, info);
        pile.target.set(cell.i * CELL, 0, cell.j * CELL);
        pile.pos.copy(pile.target);
      }
      pile.album = album;
      pile.alive = true;
      pile.rank = rank; // 0 = le plus écouté
      pile.district = null;
      // au-delà des 300 premières, les pochettes ne projettent pas d'ombre (coût divisé par deux)
      pile.cover.castShadow = shadows && rank < 300;
      if (info && info !== pile.info) this._applyCover(pile, info);
      pile.target.set(cell.i * CELL, 0, cell.j * CELL);
      pile.trackShade = new Map(album.tracks.map(([name], k) => [name, SHADES[k % SHADES.length]]));
      pile.slabs = [];
      radius = Math.max(radius, Math.hypot(pile.target.x, pile.target.z) + CELL * 0.8);
      seen.add(album.id);
    });
    for (const pile of this.piles.values()) {
      if (!seen.has(pile.id)) {
        pile.alive = false;
        pile.slabs = [];
      }
    }
    this.districts = districts.slice(0, MAX_DISTRICTS).map((d) => {
      const district = { ...d, piles: d.albumIds.map((id) => this.piles.get(id)), hi: 0 };
      for (const p of district.piles) p.district = district;
      return district;
    });

    // Une couche = `unit` écoutes (1 sur les petites périodes, 5, 25… sur un an
    // ou tout l'historique : le serveur choisit pour garder des tours lisibles).
    const unit = data.unit || 1;
    this.unit = unit;
    const old = new Map(this.slabs.map((s) => [s.key, s]));
    const dup = new Map();
    const slabs = [];
    for (const layer of data.layers) {
      const pile = this.piles.get(layer.albumId);
      if (!pile || !pile.alive) continue;
      // la clé contient l'unité : si elle change, toutes les couches sont refaites
      let key = `${layer.ts}|${layer.albumId}|${layer.track ?? `u${unit}`}`;
      const n = dup.get(key) || 0;
      dup.set(key, n + 1);
      if (n) key += `#${n}`;
      let s = old.get(key);
      if (!s) {
        const seed = layer.ts % 100000 + slabs.length * 0.37;
        s = { key, t: 0, target: 0, flash: 0, landed: false, rot: (rand(seed) - 0.5) * 0.16, ox: (rand(seed + 1) - 0.5) * 0.06, oz: (rand(seed + 2) - 0.5) * 0.06 };
      }
      s.pile = pile;
      s.ts = layer.ts; // première écoute de la couche : c'est là qu'elle tombe
      s.te = layer.te ?? layer.ts; // dernière écoute : sert à la lueur (récence)
      s.n = layer.n;
      s.unit = unit;
      s.index = pile.slabs.length; // rang de la couche dans la tour
      s.track = layer.track ?? null;
      // couche groupée incomplète (la dernière d'une tour) : plus fine
      s.frac = unit > 1 ? Math.max(0.3, layer.n / unit) : 1;
      // un ton par morceau ; sur les couches groupées, une alternance régulière
      s.shade = s.track ? pile.trackShade.get(s.track) ?? 1 : SHADES[s.index % 2 ? 1 : 0] * (s.index % 10 === 9 ? 1.3 : 1);
      s.target = layer.ts <= this.cursor ? 1 : 0;
      pile.slabs.push(s);
      slabs.push(s);
    }
    this.slabs = slabs.slice(0, MAX_SLABS);

    // Échelle : la tour la plus haute fait ~TARGET_HEIGHT, quel que soit le volume
    this.maxPlays = Math.max(1, ...data.albums.map((a) => a.plays));
    const maxLayers = Math.max(1, ...data.albums.map((a) => Math.ceil(a.plays / unit)));
    const slabH = clamp((TARGET_HEIGHT / maxLayers) * 0.8, 0.045, 0.3);
    if (Math.abs(slabH - this.slabH) > 1e-3) {
      this.slabH = slabH;
      const oldGeo = this.slabMesh.geometry;
      this.slabMesh.geometry = this._slabGeometry(slabH);
      oldGeo.dispose();
    }
    this.step = this.slabH * 1.25;

    this.radius = radius;
    this.groundMat.uniforms.uRadius.value = radius;
    const fogDensity = clamp(0.95 / (radius * 3.4 + 12), 0.008, 0.035);
    this.scene.fog.density = fogDensity;
    this.groundMat.uniforms.uFogDensity.value = fogDensity;
    this.plateMat.uniforms.uFogDensity.value = fogDensity;
    const sh = this.moon.shadow.camera;
    sh.left = sh.bottom = -(radius + 4);
    sh.right = sh.top = radius + 4;
    sh.near = 1;
    sh.far = 90;
    sh.updateProjectionMatrix();
    this.moon.position.set(radius * 0.7 + 8, 22, radius * 0.4 + 6);
    if (this.shadowPlane) this.shadowPlane.scale.setScalar(Math.max(1, (radius * 2.6) / 120 + 0.2));

    this._updateMood();
    this._buildLabels();
  }

  _createPile(album, info) {
    const mat = new THREE.MeshStandardMaterial({ roughness: 0.6, metalness: 0, transparent: true, emissive: 0xffffff, emissiveIntensity: 0.3 });
    const cover = new THREE.Mesh(this.coverGeo, mat);
    cover.castShadow = this.renderer.shadowMap.enabled;
    const halo = new THREE.Mesh(
      this.haloGeo,
      new THREE.MeshBasicMaterial({ map: this.glowTex, transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false, fog: false }),
    );
    halo.position.z = -0.02;
    cover.add(halo);
    cover.visible = false;
    this.scene.add(cover);
    const pile = {
      id: album.id,
      album,
      info: null,
      color: new THREE.Color(0.6, 0.6, 0.6),
      cover,
      halo,
      pos: new THREE.Vector3(),
      target: new THREE.Vector3(),
      slabs: [],
      trackShade: new Map(),
      alive: true,
      presence: 0,
      lift: 0,
      spread: 1,
      spreadTarget: 1,
      dim: 0,
      hover: 0,
      top: 0,
      phase: rand(album.id.length + album.plays + parseInt(album.id.slice(0, 6), 16)) * 6.28,
    };
    cover.userData.pile = pile;
    this.piles.set(album.id, pile);
    if (info) this._applyCover(pile, info);
    return pile;
  }

  _applyCover(pile, info) {
    pile.info = info;
    pile.color.copy(info.color);
    pile.cover.material.map = info.texture;
    pile.cover.material.emissiveMap = info.texture;
    pile.cover.material.needsUpdate = true;
    pile.halo.material.color.copy(info.color);
  }

  // Une vraie pochette vient d'arriver : on la pose sur sa tour.
  updateCover(id, info) {
    const pile = this.piles.get(id);
    if (!pile || pile.info === info) return;
    this._applyCover(pile, info);
    if (pile.rank < 120) this.moodDirty = true;
  }

  _disposePile(pile) {
    this.scene.remove(pile.cover);
    pile.cover.material.dispose();
    pile.halo.material.dispose();
    this.piles.delete(pile.id);
    if (this.focused === pile) this.clearFocus({ fly: false });
  }

  // L'ambiance (ciel, brume, lignes de la carte, poussière) prend les
  // couleurs des pochettes, pondérées par le nombre d'écoutes.
  _updateMood() {
    const piles = [...this.piles.values()].filter((p) => p.alive);
    if (!piles.length) return;
    // (les 120 albums principaux suffisent pour l'ambiance, même avec 1 000 tours)
    const sorted = piles.sort((a, b) => b.album.plays - a.album.plays).slice(0, 120);
    // Moyenner toutes les pochettes donne une couleur boueuse : on prend la
    // teinte des deux albums les plus écoutés, ravivée, puis on la mélange à
    // un bleu nuit pour que la ville reste nocturne.
    const first = sorted[0].color;
    const second = (sorted[1] || sorted[0]).color;
    const tint = first.clone().lerp(second, 0.35);
    const hsl = {};
    tint.getHSL(hsl);
    tint.setHSL(hsl.h, Math.max(0.6, hsl.s), 0.45);
    const mood = new THREE.Color('#3a2a8c').lerp(tint, 0.45);

    const T = this.paletteTarget;
    T.fog.set('#06050e').lerp(mood, 0.05);
    T.base.set('#040309').lerp(mood, 0.02);
    T.top.set('#010105').lerp(mood, 0.01);
    T.glow.copy(tint).multiplyScalar(0.12);
    T.accent.copy(second).multiplyScalar(0.2);
    T.line.set('#8a80d6').lerp(tint, 0.3).multiplyScalar(0.5);
    this.hemi.color.set('#b9b0ff').lerp(tint, 0.3);

    // poussière : chaque grain prend la couleur d'un album (tirage pondéré)
    const colors = this.dust.geometry.attributes.aColor;
    const position = this.dust.geometry.attributes.position;
    const cumulative = [];
    let acc = 0;
    for (const p of sorted) cumulative.push((acc += p.album.plays + 0.3));
    const R = this.radius * 1.35 + 2;
    for (let i = 0; i < colors.count; i++) {
      const r = rand(i + 11.1) * acc;
      const idx = cumulative.findIndex((v) => v >= r);
      const col = sorted[Math.max(0, idx)].color;
      colors.setXYZ(i, col.r, col.g, col.b);
      position.setXYZ(i, this.dustUnit[i * 3] * R, this.dustUnit[i * 3 + 1], this.dustUnit[i * 3 + 2] * R);
    }
    colors.needsUpdate = true;
    position.needsUpdate = true;
  }

  _buildLabels() {
    if (!this.labelsEl) return;
    this.labelsEl.replaceChildren();
    // un nom par quartier (artiste de plusieurs albums), les plus écoutés d'abord
    const max = this.container.clientWidth < 700 ? 5 : 10;
    this.labels = [...this.districts]
      .sort((a, b) => b.plays - a.plays)
      .slice(0, max)
      .map((district) => {
        const el = document.createElement('div');
        el.className = 'district';
        const name = document.createElement('span');
        name.textContent = district.name;
        const count = document.createElement('small');
        count.textContent = `${district.piles.length} albums · ${district.plays.toLocaleString('fr-FR')} écoutes`;
        el.append(name, count);
        this.labelsEl.append(el);
        return { el, district, w: el.offsetWidth || district.name.length * 9, piles: district.piles, opacity: 0, color: '' };
      });
  }

  // ------------------------------------------------------------ temps

  // Tout ce qui a été écouté avant T est construit, le reste non.
  setCursor(T) {
    this.cursor = T;
    for (const s of this.slabs) s.target = s.ts <= T ? 1 : 0;
  }

  // Une onde part de la tour (nouvelle écoute) et soulève les pochettes.
  pulse(albumId, strength = 1) {
    const p = albumId ? this.piles.get(albumId) : null;
    this.ripples.push({ x: p ? p.target.x : 0, z: p ? p.target.z : 0, start: this.time, strength });
    if (this.ripples.length > 4) this.ripples.shift();
  }

  _waveAt(x, z) {
    let w = 0;
    for (const r of this.ripples) {
      const age = this.time - r.start;
      if (age < 0 || age > 6) continue;
      const d = Math.hypot(x - r.x, z - r.z) - age * RIPPLE_SPEED;
      w += Math.exp(-d * d * 1.5) * Math.exp(-age * 0.7) * r.strength;
    }
    return w;
  }

  // Filtre venu de la frise : seules ces tours restent allumées.
  highlight(ids) {
    this.highlightSet = ids && ids.size ? ids : null;
  }

  // ------------------------------------------------------------ caméra

  _azimuth() {
    const t = this.controls.target;
    return Math.atan2(this.camera.position.x - t.x, this.camera.position.z - t.z);
  }

  overviewPose(view = this.view) {
    const portrait = this.camera.aspect < 0.9;
    const dist = (this.radius * 1.8 + 6) * (portrait ? 1.45 : 1);
    if (view === 'map') {
      return { target: new THREE.Vector3(0, 0, 0), position: new THREE.Vector3(0, dist * 1.12, dist * 0.02) };
    }
    const target = new THREE.Vector3(0, 0.9, 0);
    const position = new THREE.Vector3().setFromSphericalCoords(dist, 1.0, this._azimuth()).add(target);
    return { target, position };
  }

  flyTo(position, target, duration = 1.4) {
    const fromT = this.controls.target.clone();
    const fromOff = new THREE.Spherical().setFromVector3(this.camera.position.clone().sub(fromT));
    const toOff = new THREE.Spherical().setFromVector3(position.clone().sub(target));
    let dTheta = toOff.theta - fromOff.theta;
    dTheta = ((((dTheta + Math.PI) % (Math.PI * 2)) + Math.PI * 2) % (Math.PI * 2)) - Math.PI;
    this.flight = { fromT, toT: target.clone(), fromOff, toOff, dTheta, start: this.time, duration: this.reducedMotion ? 0.01 : duration };
  }

  overview(duration = 1.4) {
    const { position, target } = this.overviewPose();
    this.flyTo(position, target, duration);
  }

  // Ouverture : la caméra part d'en haut (vue carte) et descend dans la ville.
  intro(duration = 5) {
    const portrait = this.camera.aspect < 0.9;
    const dist = (this.radius * 1.8 + 6) * (portrait ? 1.45 : 1);
    this.controls.target.set(0, 0, 0);
    this.camera.position.set(0, dist * 1.9, dist * 0.05);
    this.controls.update();
    if (this.view === 'city') {
      const target = new THREE.Vector3(0, 0.9, 0);
      const position = new THREE.Vector3().setFromSphericalCoords(dist, 1.0, 0.6).add(target);
      this.flyTo(position, target, duration);
    } else this.overview(duration);
  }

  setView(view) {
    this.view = view;
    if (this.focused) this.clearFocus({ fly: false });
    this.controls.autoRotate = false;
    this.lastInteraction = this.time;
    this.overview(1.6);
  }

  resetView() {
    if (this.focused) this.clearFocus({ fly: false });
    this.overview(1.4);
  }

  focus(pile) {
    if (!pile || !pile.alive) return;
    if (this.focused && this.focused !== pile) this.focused.spreadTarget = 1;
    this.focused = pile;
    pile.spreadTarget = 1.9;
    this.controls.autoRotate = false;
    this.lastInteraction = this.time;
    const layers = pile.slabs.filter((s) => s.target > 0).length;
    const h = layers * this.step * 1.9;
    const target = new THREE.Vector3(pile.target.x, Math.max(0.9, h * 0.56), pile.target.z);
    const dist = Math.max(6.5, h * 1.5 + 5) * (this.camera.aspect < 0.9 ? 1.65 : 1);
    const position = new THREE.Vector3().setFromSphericalCoords(dist, 1.12, this._azimuth()).add(target);
    this.flyTo(position, target, 1.3);
    this.dispatchEvent(new CustomEvent('select', { detail: { pile } }));
  }

  focusById(id) {
    this.focus(this.piles.get(id));
  }

  clearFocus({ fly = true, silent = false } = {}) {
    if (!this.focused) return;
    this.focused.spreadTarget = 1;
    this.focused = null;
    if (fly) this.overview(1.4);
    if (!silent) this.dispatchEvent(new CustomEvent('select', { detail: { pile: null } }));
  }

  // ------------------------------------------------------------ rendu

  start() {
    this.renderer.setAnimationLoop(() => this._frame());
  }

  _frame() {
    const now = performance.now();
    const dt = Math.min((now - this.lastFrame) / 1000, 0.05);
    this.lastFrame = now;
    this.time += dt;
    const t = this.time;

    for (const key of Object.keys(this.palette)) {
      const a = this.palette[key], b = this.paletteTarget[key];
      const k = 1 - Math.exp(-1.5 * dt);
      a.r += (b.r - a.r) * k;
      a.g += (b.g - a.g) * k;
      a.b += (b.b - a.b) * k;
    }
    this.scene.fog.color.copy(this.palette.fog);
    this.scene.background.copy(this.palette.fog);
    if (this.moodDirty && t - (this.moodAt || 0) > 0.6) {
      this.moodDirty = false;
      this.moodAt = t;
      this._updateMood();
    }

    this._updateCamera(dt);
    this.camera.updateMatrixWorld();
    this._updatePiles(dt, t);
    this._updateDistricts(dt);
    this._updateNowPlaying(t);
    this._updateLabels(dt);

    this.sky.position.copy(this.camera.position);
    this.skyMat.uniforms.uTime.value = t;
    this.starMat.uniforms.uTime.value = t;
    this.dustMat.uniforms.uTime.value = t;
    this.npBeamMat.uniforms.uTime.value = t;
    const g = this.groundMat.uniforms;
    g.uTime.value = t;
    this.ripples.forEach((r, i) => g.uRipples.value[i].set(r.x, r.z, r.start, r.strength));
    for (let i = this.ripples.length; i < 4; i++) g.uRipples.value[i].set(0, 0, -100, 0);

    if (this.composer) this.composer.render(dt);
    else this.renderer.render(this.scene, this.camera);
  }

  _updateCamera(dt) {
    // Sur grand écran, le panneau d'album occupe la droite : on décale le
    // cadrage pour que la tour choisie reste visible à gauche du panneau.
    const w = this.container.clientWidth;
    const h = this.container.clientHeight;
    // Sur téléphone, le panneau est une feuille en bas : on remonte la tour.
    const wide = w > 760;
    const shiftX = this.focused && wide ? Math.min(190, w * 0.12) : 0;
    const shiftY = this.focused && !wide ? h * 0.2 : 0;
    this.viewShift = damp(this.viewShift, shiftX, 4, dt);
    this.viewShiftY = damp(this.viewShiftY || 0, shiftY, 4, dt);
    if (Math.abs(this.viewShift) > 0.5 || Math.abs(this.viewShiftY) > 0.5) {
      this.camera.setViewOffset(w, h, this.viewShift, this.viewShiftY, w, h);
    } else if (this.camera.view?.enabled) this.camera.clearViewOffset();

    const f = this.flight;
    if (f) {
      const k = easeInOutCubic(clamp((this.time - f.start) / f.duration, 0, 1));
      const target = f.fromT.clone().lerp(f.toT, k);
      const sph = new THREE.Spherical(
        lerp(f.fromOff.radius, f.toOff.radius, k),
        lerp(f.fromOff.phi, f.toOff.phi, k),
        f.fromOff.theta + f.dTheta * k,
      );
      this.camera.position.setFromSpherical(sph).add(target);
      this.controls.target.copy(target);
      this.camera.lookAt(target);
      if (k >= 1) this.flight = null;
      return;
    }
    if (!this.reducedMotion && !this.focused && this.view === 'city' && this.time - this.lastInteraction > 14) {
      this.controls.autoRotate = true;
    }
    this.controls.update();
  }

  _updatePiles(dt, t) {
    const mesh = this.slabMesh;
    const colors = mesh.instanceColor.array;
    const glows = this.glowAttr.array;
    const fpColors = this.footprints.instanceColor.array;
    const [start, end] = this.domain;
    const span = Math.max(1, end - start);
    const live = this.cursor === Infinity;
    const hl = this.slabH;
    let idx = 0;
    let fp = 0;
    const dead = [];

    for (const pile of this.piles.values()) {
      let any = false;
      let inserting = false;
      for (const s of pile.slabs) {
        if (s.target) any = true;
        if (s.t < s.target) {
          s.t = Math.min(1, s.t + dt / this.dropTime);
          if (s.t >= 1 && !s.landed) {
            s.landed = true;
            s.flash = 1;
          }
        } else if (s.t > s.target) {
          s.t = Math.max(0, s.t - dt / 0.3);
          if (s.t <= 0) s.landed = false;
        }
        if (s.t > 0 && s.t < 1) inserting = true;
        if (s.flash > 0) s.flash = Math.max(0, s.flash - dt * 1.5);
      }

      const isNP = live && pile.id === this.nowPlayingId;
      const presenceTarget = pile.alive && (any || isNP) ? 1 : 0;
      pile.presence = damp(pile.presence, presenceTarget, presenceTarget ? 6 : 4, dt);
      if (!pile.alive && pile.presence < 0.01) {
        dead.push(pile);
        continue;
      }

      let dimTarget = 0;
      if (this.focused && this.focused !== pile) dimTarget = 0.72;
      else if (!this.focused && this.highlightSet && !this.highlightSet.has(pile.id)) dimTarget = 0.8;
      pile.dim = damp(pile.dim, dimTarget, 6, dt);
      const hoverTarget = this.hovered?.pile === pile ? 1 : 0;
      pile.hover = damp(pile.hover, hoverTarget, 10, dt);
      pile.spread = damp(pile.spread, pile.spreadTarget, 5, dt);
      pile.pos.x = damp(pile.pos.x, pile.target.x, 3, dt);
      pile.pos.z = damp(pile.pos.z, pile.target.z, 3, dt);
      const isFocused = this.focused === pile;
      const liftTarget = Math.max(hoverTarget, isFocused ? 1 : 0, inserting ? 0.85 : 0, isNP ? 0.6 : 0);
      pile.lift = damp(pile.lift, liftTarget, inserting ? 9 : 5, dt);

      // couches
      const step = this.step * pile.spread;
      let y = 0;
      for (const s of pile.slabs) {
        if (idx >= MAX_SLABS) break;
        this.instanceSlabs[idx] = s;
        if (s.t <= 0) {
          _m.makeScale(0, 0, 0);
          mesh.setMatrixAt(idx++, _m);
          continue;
        }
        // la couche tombe de la pochette soulevée et rebondit sur la pile
        const fall = (1 - easeOutBounce(s.t)) * 1.15;
        const grow = easeOutCubic(Math.min(1, s.t * 2.2));
        const sc = (0.35 + 0.65 * grow) * pile.presence * (1 + pile.hover * 0.04);
        _p.set(pile.pos.x + s.ox, y + (hl * s.frac) / 2 + fall, pile.pos.z + s.oz);
        _q.setFromAxisAngle(UP, s.rot * (1 + (pile.spread - 1) * 2.5));
        _s.set(sc, s.frac, sc);
        _m.compose(_p, _q, _s);
        mesh.setMatrixAt(idx, _m);
        y += (step - hl + hl * s.frac) * easeOutCubic(Math.min(1, s.t * 1.5));

        const recency = Math.exp(-((end - s.te) / span) * 3.2);
        const hoverSlab = this.hovered?.slab === s ? 1 : 0;
        let glow = 0.05 + 2.1 * recency ** 3 + s.flash * 3 + pile.hover * 0.3 + hoverSlab * 1.6 + (isFocused ? 0.15 : 0);
        glow *= 1 - pile.dim * 0.9;
        const base = s.shade * (1 - pile.dim * 0.72);
        const k = idx * 3;
        colors[k] = pile.color.r * base;
        colors[k + 1] = pile.color.g * base;
        colors[k + 2] = pile.color.b * base;
        const gk = glow * s.shade * 0.55;
        glows[k] = pile.color.r * gk;
        glows[k + 1] = pile.color.g * gk;
        glows[k + 2] = pile.color.b * gk;
        idx++;
      }
      pile.top = y;

      // pochette (le toit)
      const cover = pile.cover;
      cover.visible = pile.presence > 0.01;
      if (cover.visible) {
        const wave = this._waveAt(pile.pos.x, pile.pos.z);
        const lift = pile.lift * (1 + (isFocused ? 0.55 : 0));
        const bob = Math.sin(t * 1.4 + pile.phase) * 0.06 * pile.lift;
        cover.position.set(pile.pos.x, pile.top + 0.014 + lift + bob + wave * 0.7, pile.pos.z);
        cover.quaternion.copy(FLAT_Q).slerp(this.camera.quaternion, Math.min(1, pile.lift * 1.1));
        cover.scale.setScalar(pile.presence * (1 + pile.lift * 0.28 + (isFocused ? 0.35 : 0)));
        cover.material.opacity = 1 - pile.dim * 0.78;
        cover.material.emissiveIntensity = 0.28 + pile.lift * 0.22 + pile.hover * 0.1;
        const haloOpacity = (pile.lift * 0.8 + wave * 0.5) * (1 - pile.dim);
        pile.halo.material.opacity = haloOpacity;
        pile.halo.visible = haloOpacity > 0.01;
      }

      // halo au sol
      if (fp < MAX_PILES) {
        const share = this.maxPlays ? pile.album.plays / this.maxPlays : 0;
        const intensity = pile.presence * (0.22 + 0.78 * share) * (1 - pile.dim * 0.85) * (0.85 + pile.hover * 0.8);
        _p.set(pile.pos.x, 0.012, pile.pos.z);
        _m.compose(_p, ID_Q, _s.setScalar(1 + pile.hover * 0.12));
        this.footprints.setMatrixAt(fp, _m);
        fpColors[fp * 3] = pile.color.r * intensity;
        fpColors[fp * 3 + 1] = pile.color.g * intensity;
        fpColors[fp * 3 + 2] = pile.color.b * intensity;
        fp++;
      }
    }

    for (const pile of dead) this._disposePile(pile);
    this.instanceSlabs.length = idx;
    mesh.count = idx;
    mesh.instanceMatrix.needsUpdate = true;
    mesh.instanceColor.needsUpdate = true;
    this.glowAttr.needsUpdate = true;
    this.footprints.count = fp;
    this.footprints.instanceMatrix.needsUpdate = true;
    this.footprints.instanceColor.needsUpdate = true;
  }

  // Le sol de chaque quartier suit ses tours : il apparaît avec la première
  // (pendant la relecture), glisse avec elles, et s'éclaire quand on survole
  // ou ouvre un de ses albums.
  _updateDistricts(dt) {
    const colors = this.plateColor.array;
    const sizes = this.plateSize.array;
    const his = this.plateHi.array;
    this.plateBoost = damp(this.plateBoost ?? 1, this.view === 'map' ? 1.7 : 1, 4, dt);
    this.plateMat.uniforms.uBoost.value = this.plateBoost;
    let n = 0;
    for (const d of this.districts) {
      let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
      let presence = 0, dim = 1, hot = 0;
      for (const p of d.piles) {
        if (!p.alive) continue;
        x0 = Math.min(x0, p.pos.x);
        x1 = Math.max(x1, p.pos.x);
        z0 = Math.min(z0, p.pos.z);
        z1 = Math.max(z1, p.pos.z);
        presence = Math.max(presence, p.presence);
        dim = Math.min(dim, p.dim);
        if (this.hovered?.pile === p || this.focused === p) hot = 1;
      }
      d.hi = damp(d.hi, hot, 8, dt);
      if (presence < 0.01 || n >= MAX_DISTRICTS) continue;
      const sx = x1 - x0 + CELL;
      const sz = z1 - z0 + CELL;
      _p.set((x0 + x1) / 2, 0.008, (z0 + z1) / 2);
      _m.compose(_p, ID_Q, _s.set(sx, 1, sz));
      this.plates.setMatrixAt(n, _m);
      const c = d.piles[0].color; // couleur de l'album le plus écouté du quartier
      const k = presence * (1 - dim * 0.85);
      colors[n * 3] = c.r * k;
      colors[n * 3 + 1] = c.g * k;
      colors[n * 3 + 2] = c.b * k;
      sizes[n * 2] = sx;
      sizes[n * 2 + 1] = sz;
      his[n] = d.hi;
      n++;
    }
    this.plates.count = n;
    this.plates.instanceMatrix.needsUpdate = true;
    this.plateColor.needsUpdate = true;
    this.plateSize.needsUpdate = true;
    this.plateHi.needsUpdate = true;
  }

  _updateNowPlaying(t) {
    const pile = this.cursor === Infinity && this.nowPlayingId ? this.piles.get(this.nowPlayingId) : null;
    const show = Boolean(pile && pile.presence > 0.05);
    this.np.visible = show;
    if (!show) return;
    const pulse = 0.5 + 0.5 * Math.sin(t * 4);
    this.np.position.set(pile.pos.x, pile.top, pile.pos.z);
    this.npGhost.position.set(0, this.slabH / 2 + 0.02 + pulse * 0.04, 0);
    this.npGhost.scale.set(1.04 * pile.presence, this.slabH, 1.04 * pile.presence);
    this.npGhost.material.color.copy(pile.color).multiplyScalar(1.2 + pulse);
    this.npGhost.material.opacity = 0.35 + 0.3 * pulse;
    this.npBeam.scale.set(1, 60, 1);
    this.npBeamMat.uniforms.uColor.value.copy(pile.color);
    this.npLight.color.copy(pile.color);
    this.npLight.position.set(0, 1.4, 0);
    this.npLight.intensity = 14 + pulse * 10;
  }

  _updateLabels(dt) {
    if (!this.labels.length) return;
    const w = this.container.clientWidth;
    const h = this.container.clientHeight;
    const mapness = this.view === 'map' ? 1 : 0;
    const placed = []; // rectangles déjà occupés : un nom ne cache jamais un autre
    for (const label of this.labels) {
      let x = 0, z = 0, wsum = 0, top = 0;
      for (const p of label.piles) {
        const wgt = p.presence * (p.album.plays + 0.2);
        x += p.pos.x * wgt;
        z += p.pos.z * wgt;
        wsum += wgt;
        top = Math.max(top, p.top);
      }
      let target = 0;
      if (wsum > 0.05) {
        // l'étiquette flotte au-dessus de la plus haute tour du quartier
        _v.set(x / wsum, top + 1.4, z / wsum).project(this.camera);
        const visible = _v.z < 1 && Math.abs(_v.x) < 1.1 && Math.abs(_v.y) < 1.1;
        if (visible) {
          const sx = (_v.x * 0.5 + 0.5) * w;
          const sy = (-_v.y * 0.5 + 0.5) * h;
          const rect = { x0: sx - label.w / 2 - 6, x1: sx + label.w / 2 + 6, y0: sy - 4, y1: sy + 30 };
          const free = !placed.some((r) => rect.x0 < r.x1 && rect.x1 > r.x0 && rect.y0 < r.y1 && rect.y1 > r.y0);
          if (free) {
            placed.push(rect);
            label.el.style.transform = `translate3d(${sx.toFixed(1)}px, ${sy.toFixed(1)}px, 0) translate(-50%, 0)`;
            const hi = label.district.hi; // quartier survolé : son nom ressort
            target = (this.focused && hi < 0.5 ? 0.15 : 0.7 + mapness * 0.25 + hi * 0.3) * Math.min(1, wsum);
          }
        }
      }
      label.opacity = damp(label.opacity, target, 6, dt);
      label.el.style.opacity = label.opacity.toFixed(3);
      const color = `#${label.piles[0].color.getHexString()}`;
      if (color !== label.color) {
        label.color = color;
        label.el.style.setProperty('--c', color);
      }
    }
  }
}
