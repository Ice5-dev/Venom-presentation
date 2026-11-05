import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { CSS3DRenderer, CSS3DObject } from 'three/addons/renderers/CSS3DRenderer.js';

/* =====================================================================
   Helpers & state
   ===================================================================== */
const $ = (s) => document.querySelector(s);
const N = 6;
const STEP = (Math.PI * 2) / N;
const FOV = 38;
const TAN = Math.tan(THREE.MathUtils.degToRad(FOV / 2));
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const lerp = (a, b, t) => a + (b - a) * t;
const smooth = (t) => { t = clamp(t, 0, 1); return t * t * (3 - 2 * t); };
const smoother = (t) => { t = clamp(t, 0, 1); return t * t * t * (t * (t * 6 - 15) + 10); };
const seg = (t, a, b) => smooth((t - a) / (b - a)); // 0..1 progress of t inside [a,b]
const V3 = THREE.Vector3;
const GREEN = new THREE.Color('#3dff8b');
const RED = new THREE.Color('#ff3b4a');
const SILVER = new THREE.Color('#c9d2d8');

const store = {
  get(k, d) { try { const v = localStorage.getItem(k); return v === null ? d : v; } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch { /* storage may be blocked */ } },
};

const mqReduce = window.matchMedia('(prefers-reduced-motion: reduce)');
const savedMotion = store.get('venom.reduced', null);
const state = {
  index: 0,
  angle: 0,
  anim: null,
  reduced: savedMotion === null ? mqReduce.matches : savedMotion === '1',
  sound: store.get('venom.sound', '1') === '1',
  intro: 0,
  ready: false,
};

/* =====================================================================
   Renderer, scene, camera
   ===================================================================== */
const canvas = $('#gl');
let renderer;
try {
  renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
} catch (err) {
  document.body.classList.add('no-webgl');
  throw err;
}
renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.75));
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1;

const scene = new THREE.Scene();
scene.background = new THREE.Color('#020403');
scene.fog = new THREE.FogExp2(0x020403, 0.026);

const camera = new THREE.PerspectiveCamera(FOV, 1, 0.1, 120);

const cssRenderer = new CSS3DRenderer({ element: $('#css') });
const cssScene = new THREE.Scene();
const cssCamera = new THREE.PerspectiveCamera(FOV, 1, 0.1, 100000); // same view as `camera`, but expressed in CSS pixels so panels stay at scale 1

/* studio environment: dark room with neon-green and white softboxes for metal reflections */
function makeEnvScene() {
  const s = new THREE.Scene();
  s.background = new THREE.Color(0x010302);
  const box = (w, h, d, x, y, z, col, k) => {
    const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d),
      new THREE.MeshBasicMaterial({ color: new THREE.Color(col).multiplyScalar(k) }));
    m.position.set(x, y, z); s.add(m);
  };
  box(18, 0.5, 7, 0, 9, 0, '#ffffff', 2.6);
  box(0.5, 7, 12, -9, 1, 2, '#3dff8b', 3.5);
  box(0.5, 6, 9, 9, 2, -2, '#9dffc9', 3.5);
  box(12, 0.5, 6, 0, -7, 3, '#20ff80', 1.5);
  box(16, 6, 0.5, 0, 2, -10, '#d5dde1', 2.5);
  box(7, 3, 0.5, 2, 1, 10, '#ffffff', 2);
  return s;
}
const pmrem = new THREE.PMREMGenerator(renderer);
scene.environment = pmrem.fromScene(makeEnvScene(), 0.03).texture;
scene.environmentIntensity = 0.85;

/* lights */
const keyLight = new THREE.DirectionalLight(0xffffff, 1.3); keyLight.position.set(4, 6, 6); scene.add(keyLight);
const rimLight = new THREE.DirectionalLight(0x7dffb8, 1.0); rimLight.position.set(-6, 2, -5); scene.add(rimLight);
const accent = new THREE.PointLight(0x3dff8b, 42, 0, 2); scene.add(accent);

/* =====================================================================
   Texture helpers
   ===================================================================== */
await Promise.all([
  document.fonts.load('900 40px Orbitron'), document.fonts.load('700 40px Orbitron'),
  document.fonts.load('600 40px Inter'),
]).catch(() => {});

function canvasTex(w, h, draw, opts = {}) {
  const c = document.createElement('canvas'); c.width = w; c.height = h;
  const ctx = c.getContext('2d'); draw(ctx, w, h);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = opts.linear ? THREE.NoColorSpace : THREE.SRGBColorSpace;
  t.anisotropy = 8; t.needsUpdate = true;
  return t;
}
const glowTex = canvasTex(128, 128, (ctx, w, h) => {
  const g = ctx.createRadialGradient(w / 2, h / 2, 0, w / 2, h / 2, w / 2);
  g.addColorStop(0, 'rgba(255,255,255,1)'); g.addColorStop(0.25, 'rgba(255,255,255,.55)');
  g.addColorStop(0.6, 'rgba(255,255,255,.12)'); g.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = g; ctx.fillRect(0, 0, w, h);
});

function glowSprite(color, size, opacity = 1) {
  const m = new THREE.SpriteMaterial({ map: glowTex, color, transparent: true, opacity, blending: THREE.AdditiveBlending, depthWrite: false });
  const s = new THREE.Sprite(m); s.scale.setScalar(size); s.userData.base = opacity; return s;
}

function labelSprite(title, sub, { color = '#ffffff', subColor = '#3dff8b', width = 2.6 } = {}) {
  const W = 640, H = 200;
  const tex = canvasTex(W, H, (ctx) => {
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.shadowColor = subColor; ctx.shadowBlur = 10;
    ctx.fillStyle = color; ctx.font = '900 86px Orbitron, sans-serif';
    ctx.fillText(title, W / 2, sub ? 70 : H / 2);
    if (sub) {
      ctx.shadowBlur = 8; ctx.fillStyle = subColor; ctx.font = '700 38px Orbitron, sans-serif';
      ctx.fillText(sub, W / 2, 148);
    }
  });
  const mat = new THREE.SpriteMaterial({ map: tex, transparent: true, depthWrite: false });
  const s = new THREE.Sprite(mat); s.scale.set(width, width * H / W, 1); s.userData.base = 1; return s;
}

/* =====================================================================
   The VENOM coin
   ===================================================================== */
function arcText(ctx, text, cx, cy, radius, centerAngle, spacing, bottom = false) {
  const chars = [...text];
  const total = chars.length * spacing;
  const dir = bottom ? -1 : 1; // bottom arc reads left-to-right with letter tops toward the centre
  let a = centerAngle - dir * (total / 2 - spacing / 2);
  for (const ch of chars) {
    ctx.save(); ctx.translate(cx + Math.cos(a) * radius, cy + Math.sin(a) * radius);
    ctx.rotate(bottom ? a - Math.PI / 2 : a + Math.PI / 2); ctx.fillText(ch, 0, 0); ctx.restore(); a += dir * spacing;
  }
}
function faceTextures() {
  const S = 1024, C = S / 2;
  const albedo = canvasTex(S, S, (ctx) => {
    const g = ctx.createRadialGradient(C, C, 0, C, C, C);
    g.addColorStop(0, '#222c28'); g.addColorStop(0.7, '#111916'); g.addColorStop(1, '#1f2924');
    ctx.fillStyle = g; ctx.fillRect(0, 0, S, S);
    ctx.strokeStyle = 'rgba(255,255,255,.05)'; ctx.lineWidth = 1;
    for (let r = 40; r < C; r += 9) { ctx.beginPath(); ctx.arc(C, C, r, 0, 7); ctx.stroke(); }
    ctx.fillStyle = '#c4ccd1'; ctx.font = '900 54px Orbitron, sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    arcText(ctx, 'VENOM ◆ VENOM ◆ VENOM ◆ VENOM ◆', C, C, 398, -Math.PI / 2, 0.205);
    arcText(ctx, 'VENOM ◆ VENOM ◆ VENOM ◆ VENOM ◆', C, C, 398, Math.PI / 2, 0.205, true);
  });
  const emissive = canvasTex(S, S, (ctx) => {
    ctx.fillStyle = '#000'; ctx.fillRect(0, 0, S, S);
    ctx.strokeStyle = '#27ff80'; ctx.lineCap = 'round';
    ctx.lineWidth = 7; ctx.beginPath(); ctx.arc(C, C, 338, 0, 7); ctx.stroke();
    ctx.lineWidth = 4; ctx.beginPath(); ctx.arc(C, C, 462, 0, 7); ctx.stroke();
    ctx.lineWidth = 2; ctx.beginPath(); ctx.arc(C, C, 478, 0, 7); ctx.stroke();
    ctx.lineWidth = 3;
    for (let k = 0; k < 120; k++) { // tick marks
      const a = (k / 120) * Math.PI * 2, r0 = 440, r1 = k % 5 === 0 ? 424 : 432;
      ctx.beginPath(); ctx.moveTo(C + Math.cos(a) * r0, C + Math.sin(a) * r0); ctx.lineTo(C + Math.cos(a) * r1, C + Math.sin(a) * r1); ctx.stroke();
    }
    ctx.globalAlpha = 0.55; ctx.lineWidth = 3; // circuit traces between V and ring
    for (let k = 0; k < 8; k++) {
      const a = (k / 8) * Math.PI * 2 + Math.PI / 8, r0 = 340, r1 = 372;
      ctx.beginPath(); ctx.moveTo(C + Math.cos(a) * r0, C + Math.sin(a) * r0); ctx.lineTo(C + Math.cos(a) * r1, C + Math.sin(a) * r1); ctx.stroke();
      ctx.beginPath(); ctx.arc(C + Math.cos(a) * r1, C + Math.sin(a) * r1, 7, 0, 7); ctx.fillStyle = '#27ff80'; ctx.fill();
    }
    ctx.globalAlpha = 0.18; ctx.fillStyle = '#27ff80'; ctx.font = '900 54px Orbitron, sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    arcText(ctx, 'VENOM ◆ VENOM ◆ VENOM ◆ VENOM ◆', C, C, 398, -Math.PI / 2, 0.205);
    arcText(ctx, 'VENOM ◆ VENOM ◆ VENOM ◆ VENOM ◆', C, C, 398, Math.PI / 2, 0.205, true);
  });
  return { albedo, emissive };
}
function reedTexture() {
  const t = canvasTex(64, 8, (ctx, w, h) => {
    ctx.fillStyle = '#000'; ctx.fillRect(0, 0, w, h); ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, w / 2, h);
  }, { linear: true });
  t.wrapS = t.wrapT = THREE.RepeatWrapping; t.repeat.set(2, 1); t.colorSpace = THREE.NoColorSpace; t.anisotropy = 4;
  return t;
}
function roundedRectProfile(cx, cy, hw, hh, rr, steps = 6) {
  const pts = []; // counter-clockwise
  const corner = (ccx, ccy, a0) => { for (let i = 0; i <= steps; i++) { const a = a0 + (i / steps) * Math.PI / 2; pts.push(new THREE.Vector2(ccx + Math.cos(a) * rr, ccy + Math.sin(a) * rr)); } };
  corner(cx + hw - rr, cy - hh + rr, -Math.PI / 2);
  corner(cx + hw - rr, cy + hh - rr, 0);
  corner(cx - hw + rr, cy + hh - rr, Math.PI / 2);
  corner(cx - hw + rr, cy - hh + rr, Math.PI);
  pts.push(pts[0].clone());
  return pts;
}
function vShape() {
  const s = new THREE.Shape();
  const pts = [[-0.98, 0.82], [-0.5, 0.82], [0, -0.14], [0.5, 0.82], [0.98, 0.82], [0.24, -0.86], [-0.24, -0.86]];
  s.moveTo(...pts[0]); for (let i = 1; i < pts.length; i++) s.lineTo(...pts[i]); s.closePath();
  return s;
}
function buildCoin() {
  const coin = new THREE.Group();
  const spin = new THREE.Group(); coin.add(spin);
  const { albedo, emissive } = faceTextures();
  const silver = new THREE.MeshStandardMaterial({ color: 0xc3cad0, metalness: 1, roughness: 0.28, envMapIntensity: 1.0 });
  const body = new THREE.MeshStandardMaterial({ color: 0x8a9399, metalness: 1, roughness: 0.38 });
  const field = new THREE.MeshStandardMaterial({ map: albedo, emissiveMap: emissive, emissive: 0xffffff, emissiveIntensity: 0.6, metalness: 0.85, roughness: 0.34 });
  const neon = new THREE.MeshStandardMaterial({ color: 0x0a2e1b, emissive: 0x2dff82, emissiveIntensity: 1.15, metalness: 0.5, roughness: 0.35 });
  const reed = reedTexture();
  const rimMat = silver.clone(); rimMat.bumpMap = reed; rimMat.bumpScale = 1.6;

  const bodyMesh = new THREE.Mesh(new THREE.CylinderGeometry(1.8, 1.8, 0.2, 96), body);
  bodyMesh.rotation.x = Math.PI / 2; spin.add(bodyMesh);

  const rimGeo = new THREE.LatheGeometry(roundedRectProfile(1.86, 0, 0.14, 0.17, 0.06), 192);
  const rim = new THREE.Mesh(rimGeo, rimMat); rim.rotation.x = Math.PI / 2; spin.add(rim);
  reed.repeat.set(72, 1);

  for (const side of [1, -1]) {
    const face = new THREE.Mesh(new THREE.CircleGeometry(1.72, 128), field);
    face.position.z = 0.1035 * side; if (side < 0) face.rotation.y = Math.PI; spin.add(face);
    const geo = new THREE.ExtrudeGeometry(vShape(), { depth: 0.07, bevelEnabled: true, bevelThickness: 0.03, bevelSize: 0.03, bevelSegments: 3, curveSegments: 4 });
    geo.scale(0.88, 0.88, 1); geo.translate(0, 0.02, 0.105);
    const v = new THREE.Mesh(geo, neon);
    if (side < 0) v.rotation.y = Math.PI; spin.add(v);
  }
  return { coin, spin, neon, field };
}
const { coin, spin: coinSpin, neon: neonMat, field: fieldMat } = buildCoin();
scene.add(coin);

const halo = glowSprite(0x3dff8b, 9, 0.16); halo.position.z = -1.4; scene.add(halo);

/* =====================================================================
   Environment: floor rings, drifting blockchain, dust, emitter particles
   ===================================================================== */
const FLOOR_Y = -2.75;
const floor = new THREE.Group(); scene.add(floor);
{
  const lm = (o) => new THREE.LineBasicMaterial({ color: 0x3dff8b, transparent: true, opacity: o, blending: THREE.AdditiveBlending, depthWrite: false });
  for (const r of [3, 4.6, 6.4, 8.6, 11.5, 15, 20]) {
    const pts = []; for (let i = 0; i < 160; i++) { const a = (i / 160) * Math.PI * 2; pts.push(new V3(Math.cos(a) * r, 0, Math.sin(a) * r)); }
    const l = new THREE.LineLoop(new THREE.BufferGeometry().setFromPoints(pts), lm(r < 9 ? 0.26 : 0.14)); l.position.y = FLOOR_Y; floor.add(l);
  }
  const rad = []; for (let i = 0; i < 72; i++) { const a = (i / 72) * Math.PI * 2; rad.push(new V3(Math.cos(a) * 3, 0, Math.sin(a) * 3), new V3(Math.cos(a) * 24, 0, Math.sin(a) * 24)); }
  const rl = new THREE.LineSegments(new THREE.BufferGeometry().setFromPoints(rad), lm(0.1)); rl.position.y = FLOOR_Y; floor.add(rl);
  const disc = new THREE.Mesh(new THREE.CircleGeometry(18, 64), new THREE.MeshBasicMaterial({ map: glowTex, color: 0x1fff7a, transparent: true, opacity: 0.07, blending: THREE.AdditiveBlending, depthWrite: false, fog: false }));
  disc.rotation.x = -Math.PI / 2; disc.position.y = FLOOR_Y - 0.02; floor.add(disc);
}

/* a ring of floating blocks joined by thin links: the "chain" orbiting the scene */
const chain = new THREE.Group(); scene.add(chain);
const chainBlocks = [];
{
  const NB = 30, R = 13.5;
  const edgeMat = new THREE.LineBasicMaterial({ color: 0x3dff8b, transparent: true, opacity: 0.55, blending: THREE.AdditiveBlending, depthWrite: false });
  const fillMat = new THREE.MeshBasicMaterial({ color: 0x0b3f25, transparent: true, opacity: 0.35, depthWrite: false });
  const pts = [];
  for (let i = 0; i < NB; i++) {
    const a = (i / NB) * Math.PI * 2, s = 0.45 + ((i * 37) % 10) / 14;
    const g = new THREE.BoxGeometry(s, s, s);
    const m = new THREE.Group();
    m.add(new THREE.LineSegments(new THREE.EdgesGeometry(g), edgeMat)); m.add(new THREE.Mesh(g, fillMat));
    m.position.set(Math.cos(a) * R, 0.6 + Math.sin(i * 1.7) * 2.2, Math.sin(a) * R); m.userData.spin = 0.2 + (i % 5) * 0.08;
    chain.add(m); chainBlocks.push(m); pts.push(m.position.clone());
  }
  const links = []; for (let i = 0; i < NB; i++) links.push(pts[i], pts[(i + 1) % NB]);
  chain.add(new THREE.LineSegments(new THREE.BufferGeometry().setFromPoints(links), new THREE.LineBasicMaterial({ color: 0x9dffc9, transparent: true, opacity: 0.28, blending: THREE.AdditiveBlending, depthWrite: false })));
}

/* far "station" pylons — one per section — so travelling around the circle reads as motion through space */
const pylons = [];
for (let i = 0; i < N; i++) {
  const a = i * STEP + Math.PI;
  const g = new THREE.Group(); g.position.set(Math.sin(a) * 17, FLOOR_Y, Math.cos(a) * 17);
  const beam = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.05, 11, 8, 1, true),
    new THREE.MeshBasicMaterial({ color: 0x3dff8b, transparent: true, opacity: 0.35, blending: THREE.AdditiveBlending, depthWrite: false }));
  beam.position.y = 5.5; g.add(beam);
  const ring = new THREE.Mesh(new THREE.TorusGeometry(0.8, 0.03, 8, 40), new THREE.MeshBasicMaterial({ color: 0x3dff8b, transparent: true, opacity: 0.6, blending: THREE.AdditiveBlending, depthWrite: false }));
  ring.rotation.x = Math.PI / 2; ring.position.y = 0.05; g.add(ring);
  const num = labelSprite(String(i + 1).padStart(2, '0'), null, { width: 2.2, subColor: '#3dff8b' }); num.position.y = 12.2; g.add(num);
  scene.add(g); pylons.push({ beam, ring, num });
}

/* dust */
const dust = (() => {
  const n = 900, pos = new Float32Array(n * 3), col = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    const r = 6 + Math.random() * 34, a = Math.random() * Math.PI * 2;
    pos.set([Math.cos(a) * r, (Math.random() - 0.35) * 22, Math.sin(a) * r], i * 3);
    const c = Math.random() < 0.55 ? GREEN : SILVER; col.set([c.r, c.g, c.b], i * 3);
  }
  const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.BufferAttribute(pos, 3)); g.setAttribute('color', new THREE.BufferAttribute(col, 3));
  const p = new THREE.Points(g, new THREE.PointsMaterial({ size: 0.11, map: glowTex, vertexColors: true, transparent: true, opacity: 0.75, blending: THREE.AdditiveBlending, depthWrite: false }));
  scene.add(p); return p;
})();

/* particles released by the coin */
const emitter = (() => {
  const n = 240, pos = new Float32Array(n * 3), col = new Float32Array(n * 3), vel = new Float32Array(n * 3), life = new Float32Array(n), max = new Float32Array(n);
  const respawn = (i, initial) => {
    const th = Math.random() * Math.PI * 2, ph = Math.acos(2 * Math.random() - 1), r = 1.95 + Math.random() * 0.25;
    const d = new V3(Math.sin(ph) * Math.cos(th), Math.cos(ph) * 0.8, Math.sin(ph) * Math.sin(th));
    pos.set([d.x * r, d.y * r, d.z * r], i * 3);
    const sp = 0.25 + Math.random() * 0.5; vel.set([d.x * sp, d.y * sp + 0.12, d.z * sp], i * 3);
    max[i] = 3 + Math.random() * 4; life[i] = initial ? Math.random() * max[i] : 0;
  };
  for (let i = 0; i < n; i++) respawn(i, true);
  const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.BufferAttribute(pos, 3)); g.setAttribute('color', new THREE.BufferAttribute(col, 3));
  const pts = new THREE.Points(g, new THREE.PointsMaterial({ size: 0.1, map: glowTex, vertexColors: true, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false }));
  scene.add(pts);
  const tint = new THREE.Color();
  return {
    pts,
    update(dt, redness) {
      tint.copy(GREEN).lerp(RED, redness);
      for (let i = 0; i < n; i++) {
        if (!state.reduced) {
          life[i] += dt;
          if (life[i] > max[i]) respawn(i, false);
          pos[i * 3] += vel[i * 3] * dt; pos[i * 3 + 1] += vel[i * 3 + 1] * dt; pos[i * 3 + 2] += vel[i * 3 + 2] * dt;
        }
        const a = Math.sin(Math.PI * clamp(life[i] / max[i], 0, 1)) * 0.9;
        col[i * 3] = tint.r * a; col[i * 3 + 1] = tint.g * a; col[i * 3 + 2] = tint.b * a;
      }
      g.attributes.position.needsUpdate = true; g.attributes.color.needsUpdate = true;
    },
  };
})();

/* =====================================================================
   Per-section 3D effects. Every effect lives in a group rotated to its
   section's angle, so local +x is screen-right and +z points at the camera.
   ===================================================================== */
const FX = new Array(N).fill(null);
const fxShared = { coinKick: 0, red: 0 };
function track(g) { // collect materials so a single weight can fade the whole group
  const list = [];
  g.traverse((o) => { const ms = Array.isArray(o.material) ? o.material : o.material ? [o.material] : []; ms.forEach((m) => { if (m.userData.base === undefined) m.userData.base = m.opacity; list.push(m); }); });
  return list;
}
function fadeGroup(list, w, extra = 1) { for (const m of list) m.opacity = (m.userData.base ?? 1) * w * extra; }

/* ---------- 02 · holographic timeline orbiting one side of the coin ---------- */
FX[1] = (() => {
  const g = new THREE.Group(); g.rotation.y = 1 * STEP;
  const inner = new THREE.Group(); inner.rotation.set(-0.12, 0, 0); g.add(inner);
  const R = 2.8, a0 = 2.35, a1 = 0.79, cy0 = -0.3;
  const P = (r, a) => new V3(Math.cos(a) * r, Math.sin(a) * r + cy0, 0);
  const arcPts = (r) => { const p = []; for (let k = 0; k <= 100; k++) p.push(P(r, a0 + (a1 - a0) * (k / 100))); return p; };
  const mainCurve = new THREE.CatmullRomCurve3(arcPts(R));
  const tube = new THREE.Mesh(new THREE.TubeGeometry(mainCurve, 200, 0.03, 6, false),
    new THREE.MeshBasicMaterial({ color: 0x3dff8b, transparent: true, opacity: 0.95, blending: THREE.AdditiveBlending, depthWrite: false }));
  inner.add(tube);
  for (const dr of [-0.26, 0.26]) {
    inner.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(arcPts(R + dr)),
      new THREE.LineBasicMaterial({ color: 0x9dffc9, transparent: true, opacity: 0.32, blending: THREE.AdditiveBlending, depthWrite: false })));
  }
  const ticks = []; for (let k = 0; k <= 48; k++) { const a = a0 + (a1 - a0) * (k / 48); ticks.push(P(R - 0.12, a), P(R + (k % 4 === 0 ? 0.24 : 0.12), a)); }
  inner.add(new THREE.LineSegments(new THREE.BufferGeometry().setFromPoints(ticks), new THREE.LineBasicMaterial({ color: 0x3dff8b, transparent: true, opacity: 0.5, blending: THREE.AdditiveBlending, depthWrite: false })));

  const info = [['2022', 'FOUNDATION', 0.06], ['MAR 2024', 'MAINNET', 0.94]];
  const nodes = info.map(([t, s, u], idx) => {
    const p = mainCurve.getPointAt(u);
    const orb = glowSprite(0x3dff8b, 0.55); orb.position.copy(p); inner.add(orb);
    const core = new THREE.Mesh(new THREE.SphereGeometry(0.08, 16, 12), new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true })); core.position.copy(p); inner.add(core);
    const top = p.clone().add(new V3(0, 0.42, 0));
    inner.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints([p, top]), new THREE.LineBasicMaterial({ color: 0x3dff8b, transparent: true, opacity: 0.6, blending: THREE.AdditiveBlending, depthWrite: false })));
    const label = labelSprite(t, s, { width: 1.95 }); label.position.copy(top).add(new V3(0, 0.34, 0)); inner.add(label);
    return { orb, core, label, u, idx };
  });
  const pulse = glowSprite(0xffffff, 0.4); inner.add(pulse);
  const mats = track(g);
  const idxCount = tube.geometry.index.count;
  g.visible = false; scene.add(g);
  return {
    group: g,
    update(t, tin, w, time) {
      const prog = state.reduced ? 1 : smoother(tin / 2.4);
      tube.geometry.setDrawRange(0, Math.floor((idxCount * prog) / 3) * 3);
      inner.rotation.y = state.reduced ? 0 : Math.sin(time * 0.4) * 0.22;
      fadeGroup(mats, w);
      for (const n of nodes) {
        const on = prog >= n.u - 0.02 ? 1 : 0;
        n.orb.visible = n.core.visible = n.label.visible = !!on;
        n.label.material.opacity = w * smooth((prog - n.u) / 0.12 + 0.2);
        const pulseK = state.reduced ? 1 : 1 + 0.18 * Math.sin(time * 2.4 + n.idx);
        n.orb.scale.setScalar(0.55 * pulseK);
      }
      const pu = state.reduced ? 0.5 : (time * 0.16) % 1;
      pulse.position.copy(mainCurve.getPointAt(pu)); pulse.visible = prog > 0.98 && !state.reduced;
    },
  };
})();

/* ---------- 03 · congestion: crowded red transaction lines ---------- */
FX[2] = (() => {
  const g = new THREE.Group(); g.rotation.y = 2 * STEP;
  const NL = 340;
  const dirs = [], r0 = new Float32Array(NL), r1 = new Float32Array(NL), spd = new Float32Array(NL), ph = new Float32Array(NL), len = new Float32Array(NL);
  for (let i = 0; i < NL; i++) {
    let d; do { d = new V3(Math.random() * 2 - 1, (Math.random() * 2 - 1) * 0.8, Math.random() * 2 - 1); } while (d.lengthSq() > 1 || d.lengthSq() < 0.1);
    d.normalize(); if (d.z > 0.55) d.z *= 0.55; d.normalize(); dirs.push(d);
    r0[i] = 6.2 + Math.random() * 2.8; r1[i] = 2.15 + Math.random() * 0.7; spd[i] = 0.18 + Math.random() * 0.5; ph[i] = Math.random(); len[i] = 0.5 + Math.random() * 1.1;
  }
  const lp = new Float32Array(NL * 6), lc = new Float32Array(NL * 6);
  const lg = new THREE.BufferGeometry(); lg.setAttribute('position', new THREE.BufferAttribute(lp, 3)); lg.setAttribute('color', new THREE.BufferAttribute(lc, 3));
  const lines = new THREE.LineSegments(lg, new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false }));
  lines.frustumCulled = false; g.add(lines);

  const NP = 260, pp = new Float32Array(NP * 3), pBase = [];
  for (let i = 0; i < NP; i++) { const d = new V3(Math.random() * 2 - 1, Math.random() * 2 - 1, Math.random() * 2 - 1).normalize(); const r = 2.35 + Math.random() * 1.1; pBase.push({ d, r, s: Math.random() * 6 }); }
  const pg = new THREE.BufferGeometry(); pg.setAttribute('position', new THREE.BufferAttribute(pp, 3));
  const jam = new THREE.Points(pg, new THREE.PointsMaterial({ color: 0xff3b4a, size: 0.17, map: glowTex, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false }));
  jam.frustumCulled = false; g.add(jam);
  const ring = new THREE.Mesh(new THREE.TorusGeometry(2.45, 0.025, 8, 120), new THREE.MeshBasicMaterial({ color: 0xff3b4a, transparent: true, opacity: 0.8, blending: THREE.AdditiveBlending, depthWrite: false })); g.add(ring);
  const ring2 = ring.clone(); ring2.material = ring.material.clone(); ring2.scale.setScalar(1.25); g.add(ring2);
  const mats = track(g);
  g.visible = false; scene.add(g);
  const tmp = new V3();
  return {
    group: g,
    update(t, tin, w, time) {
      const reveal = state.reduced ? 1 : smooth(tin / 2.6);
      const visible = Math.floor(NL * reveal);
      lg.setDrawRange(0, visible * 2);
      for (let i = 0; i < NL; i++) {
        const u = state.reduced ? ph[i] : (ph[i] + time * spd[i] * 0.35) % 1;
        const e = 1 - Math.pow(1 - u, 1.6);
        const rad = lerp(r0[i], r1[i], e), tail = rad + len[i] * (1 - e * 0.6);
        const d = dirs[i];
        lp[i * 6] = d.x * rad; lp[i * 6 + 1] = d.y * rad; lp[i * 6 + 2] = d.z * rad;
        lp[i * 6 + 3] = d.x * tail; lp[i * 6 + 4] = d.y * tail; lp[i * 6 + 5] = d.z * tail;
        const b = 0.35 + e * 0.9;
        lc[i * 6] = 1.0 * b; lc[i * 6 + 1] = 0.12 * b; lc[i * 6 + 2] = 0.16 * b;
        lc[i * 6 + 3] = 0.25 * b; lc[i * 6 + 4] = 0.02 * b; lc[i * 6 + 5] = 0.04 * b;
      }
      lg.attributes.position.needsUpdate = true; lg.attributes.color.needsUpdate = true;
      for (let i = 0; i < NP; i++) {
        const b = pBase[i], j = state.reduced ? 0 : Math.sin(time * 2.3 + b.s) * 0.07;
        tmp.copy(b.d).multiplyScalar(b.r + j); pp[i * 3] = tmp.x; pp[i * 3 + 1] = tmp.y; pp[i * 3 + 2] = tmp.z;
      }
      pg.attributes.position.needsUpdate = true;
      jam.visible = reveal > 0.2;
      const beat = state.reduced ? 0.5 : 0.5 + 0.5 * Math.sin(time * 3.2);
      ring.rotation.set(Math.PI / 2 * 0 + 0.0, 0, 0); ring.material.opacity = w * (0.45 + 0.4 * beat) * reveal;
      ring2.material.opacity = w * (0.15 + 0.2 * (1 - beat)) * reveal; ring2.scale.setScalar(1.15 + 0.15 * beat);
      lines.material.opacity = w; jam.material.opacity = w * 0.95;
      fxShared.red = Math.max(fxShared.red, w * reveal * 0.85);
    },
  };
})();

/* ---------- 04 · the coin splits the network into parallel green shards ---------- */
FX[3] = (() => {
  const g = new THREE.Group(); g.rotation.y = 3 * STEP;
  const NS = 6, ri = 2.35, ro = 2.95, gapA = 0.05;
  const shards = [];
  const shapeFor = (a0, a1) => {
    const s = new THREE.Shape();
    s.moveTo(Math.cos(a0) * ri, Math.sin(a0) * ri); s.lineTo(Math.cos(a0) * ro, Math.sin(a0) * ro);
    s.absarc(0, 0, ro, a0, a1, false); s.lineTo(Math.cos(a1) * ri, Math.sin(a1) * ri); s.absarc(0, 0, ri, a1, a0, true);
    return s;
  };
  const dots = [];
  for (let k = 0; k < NS; k++) {
    const a0 = (k / NS) * Math.PI * 2 + gapA, a1 = ((k + 1) / NS) * Math.PI * 2 - gapA, mid = (a0 + a1) / 2;
    const geo = new THREE.ExtrudeGeometry(shapeFor(a0, a1), { depth: 0.1, bevelEnabled: false, curveSegments: 20 }); geo.translate(0, 0, -0.05);
    const fill = new THREE.MeshBasicMaterial({ color: 0x1fff7a, transparent: true, opacity: 0.2, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide });
    const edge = new THREE.LineSegments(new THREE.EdgesGeometry(geo, 20), new THREE.LineBasicMaterial({ color: 0x7dffb8, transparent: true, opacity: 1, blending: THREE.AdditiveBlending, depthWrite: false }));
    const grp = new THREE.Group(); grp.add(new THREE.Mesh(geo, fill), edge);
    const beam = new THREE.Line(new THREE.BufferGeometry().setFromPoints([new V3(Math.cos(mid) * 2.0, Math.sin(mid) * 2.0, 0), new V3(Math.cos(mid) * ri, Math.sin(mid) * ri, 0)]),
      new THREE.LineBasicMaterial({ color: 0x9dffc9, transparent: true, opacity: 0.9, blending: THREE.AdditiveBlending, depthWrite: false })); grp.add(beam);
    g.add(grp); shards.push({ grp, mid, a0, a1, fill, edge, beam });
    for (let lane = 0; lane < 3; lane++) for (let d = 0; d < 6; d++) dots.push({ k, lane, ph: d / 6, sp: 0.09 + ((k * 3 + lane) % 5) * 0.035 });
  }
  const dp = new Float32Array(dots.length * 3), dg = new THREE.BufferGeometry(); dg.setAttribute('position', new THREE.BufferAttribute(dp, 3));
  const dotPts = new THREE.Points(dg, new THREE.PointsMaterial({ color: 0xcaffe0, size: 0.16, map: glowTex, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false })); dotPts.frustumCulled = false;
  g.add(dotPts);
  const mats = track(g);
  g.visible = false; scene.add(g);
  const base = new THREE.Color(0xc9d2d8), neon = new THREE.Color(0x1fff7a);
  return {
    group: g,
    update(t, tin, w, time) {
      const tt = state.reduced ? 99 : tin;
      const split = smoother((tt - 1.3) / 1.7), appear = smooth(tt / 1.0);
      fxShared.coinKick = Math.max(fxShared.coinKick, w * Math.exp(-Math.pow((tt - 1.5) * 2.2, 2)) * 0.1);
      for (const s of shards) {
        const off = split * 0.3; s.grp.position.set(Math.cos(s.mid) * off, Math.sin(s.mid) * off, 0);
        s.grp.rotation.z = split * (state.reduced ? 0 : Math.sin(time * 0.6 + s.mid) * 0.035);
        const c = base.clone().lerp(neon, split);
        s.fill.color.copy(c); s.fill.opacity = w * appear * (0.05 + 0.05 * split); s.edge.material.color.copy(c.clone().lerp(new THREE.Color(0xffffff), 0.35)); s.edge.material.opacity = w * appear;
        s.beam.material.opacity = w * appear * (0.5 + 0.5 * split);
      }
      dotPts.material.opacity = w * smooth((tt - 2.6) / 0.8);
      dotPts.visible = dotPts.material.opacity > 0.01;
      for (let i = 0; i < dots.length; i++) {
        const d = dots[i], s = shards[d.k];
        const u = state.reduced ? d.ph : (d.ph + time * d.sp) % 1;
        const a = lerp(s.a0 + 0.04, s.a1 - 0.04, u), r = lerp(ri + 0.22, ro - 0.22, (d.lane + 0.5) / 3), off = split * 0.3;
        dp[i * 3] = Math.cos(a) * r + Math.cos(s.mid) * off; dp[i * 3 + 1] = Math.sin(a) * r + Math.sin(s.mid) * off; dp[i * 3 + 2] = 0.02;
      }
      dg.attributes.position.needsUpdate = true;
    },
  };
})();

/* ---------- 05 · price chart rises and falls, then the network rebuilds ---------- */
FX[4] = (() => {
  const g = new THREE.Group(); g.rotation.y = 4 * STEP;
  const chart = new THREE.Group(); chart.position.set(0.6, -0.05, 1.3); chart.scale.setScalar(0.68); g.add(chart);
  const keys = [[-5.0, -1.55], [-4.35, -1.4], [-3.8, -1.05], [-3.3, 0.2], [-2.85, 1.9], [-2.5, 2.95], [-2.15, 2.5], [-1.6, 1.3], [-0.9, 0.1], [-0.1, -0.7], [0.8, -1.15], [1.7, -1.4], [2.5, -1.5]];
  const curve = new THREE.CatmullRomCurve3(keys.map(([x, y]) => new V3(x, y, 0)));
  const tube = new THREE.Mesh(new THREE.TubeGeometry(curve, 260, 0.045, 6, false), new THREE.MeshBasicMaterial({ color: 0x3dff8b, transparent: true, opacity: 1, blending: THREE.AdditiveBlending, depthWrite: false }));
  chart.add(tube);
  const SAMP = 160, base = -1.85;
  const ap = new Float32Array(SAMP * 2 * 3), ac = new Float32Array(SAMP * 2 * 3), idx = [];
  for (let i = 0; i < SAMP; i++) {
    const p = curve.getPointAt(i / (SAMP - 1));
    ap.set([p.x, p.y, 0, p.x, base, 0], i * 6); ac.set([0.1, 0.5, 0.25, 0, 0, 0], i * 6);
    if (i < SAMP - 1) { const a = i * 2; idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2); }
  }
  const ag = new THREE.BufferGeometry(); ag.setAttribute('position', new THREE.BufferAttribute(ap, 3)); ag.setAttribute('color', new THREE.BufferAttribute(ac, 3)); ag.setIndex(idx);
  const area = new THREE.Mesh(ag, new THREE.MeshBasicMaterial({ vertexColors: true, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide }));
  chart.add(area);
  const gridPts = []; for (let k = 0; k <= 4; k++) { const y = base + k * 1.2; gridPts.push(new V3(-5.4, y, 0), new V3(2.9, y, 0)); }
  gridPts.push(new V3(-5.4, base, 0), new V3(-5.4, base + 4.8, 0));
  const grid = new THREE.LineSegments(new THREE.BufferGeometry().setFromPoints(gridPts), new THREE.LineBasicMaterial({ color: 0xc9d2d8, transparent: true, opacity: 0.22, blending: THREE.AdditiveBlending, depthWrite: false })); chart.add(grid);
  const peakPos = curve.getPointAt(0.43); // approximate peak location
  const peakDot = glowSprite(0x3dff8b, 1.1); const endPt = keys[keys.length - 1];
  const peak = new V3(-2.5, 2.95, 0); peakDot.position.copy(peak); chart.add(peakDot);
  const peakLbl = labelSprite('PEAK', 'ALL-TIME HIGH', { width: 2.2 }); peakLbl.position.set(-3.55, 3.55, 0.1); chart.add(peakLbl);
  const endDot = glowSprite(0xff3b4a, 0.9); endDot.position.set(endPt[0], endPt[1], 0); chart.add(endDot);
  const endLbl = labelSprite('−97%', '$0.009–0.015 NOW', { width: 2.5, color: '#ff6a77', subColor: '#ff4455' }); endLbl.position.set(1.9, -2.7, 0.1); chart.add(endLbl);
  const endLeader = new THREE.Line(new THREE.BufferGeometry().setFromPoints([new V3(endPt[0], endPt[1] - 0.12, 0), new V3(1.9, -2.2, 0)]), new THREE.LineBasicMaterial({ color: 0xff4455, transparent: true, opacity: 0.7, blending: THREE.AdditiveBlending, depthWrite: false })); chart.add(endLeader);
  const tubeIdx = tube.geometry.index.count, areaIdx = idx.length;

  /* network rebuilding around the coin */
  const net = new THREE.Group(); g.add(net);
  const NN = 30, nodes = [];
  for (let i = 0; i < NN; i++) { // fibonacci-ish shell biased to the camera-facing hemisphere
    const f = (i + 0.5) / NN, phi = Math.acos(1 - 2 * f), th = Math.PI * (1 + Math.sqrt(5)) * i, r = 2.6 + ((i * 7) % 5) * 0.17;
    nodes.push(new V3(Math.sin(phi) * Math.cos(th) * r, Math.cos(phi) * r * 0.85, Math.sin(phi) * Math.sin(th) * r));
  }
  const edges = [];
  for (let i = 0; i < NN; i++) {
    const near = nodes.map((p, j) => [p.distanceTo(nodes[i]), j]).filter(([, j]) => j !== i).sort((a, b) => a[0] - b[0]).slice(0, 2);
    for (const [, j] of near) if (!edges.find(([a, b]) => (a === i && b === j) || (a === j && b === i))) edges.push([i, j]);
    edges.push([i, -1]);
  }
  const eMat = new THREE.LineBasicMaterial({ color: 0x3dff8b, transparent: true, opacity: 0.6, blending: THREE.AdditiveBlending, depthWrite: false });
  const edgeLines = edges.map(([a, b]) => {
    const pts = [nodes[a], b < 0 ? nodes[a].clone().setLength(2.05) : nodes[b]];
    const l = new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts), eMat.clone()); net.add(l); return { l, a, b };
  });
  const nodeSprites = nodes.map((p) => { const s = glowSprite(0x7dffb8, 0.32); s.position.copy(p); net.add(s); return s; });
  const coreSprites = nodes.map((p) => { const m = new THREE.Mesh(new THREE.SphereGeometry(0.045, 10, 8), new THREE.MeshBasicMaterial({ color: 0xbfffd9, transparent: true })); m.position.copy(p); net.add(m); return m; });
  const mats = track(g);
  g.visible = false; scene.add(g);
  return {
    group: g,
    update(t, tin, w, time) {
      const tt = state.reduced ? 99 : tin;
      const draw = smoother(tt / 3.4);
      tube.geometry.setDrawRange(0, Math.floor((tubeIdx * draw) / 3) * 3);
      ag.setDrawRange(0, Math.floor((areaIdx * draw) / 6) * 6);
      fadeGroup(mats, w);
      const fadeChart = 1 - 0.5 * smooth((tt - 4.2) / 2.0);
      for (const m of [tube.material, area.material, grid.material]) m.opacity = (m === grid.material ? 0.22 : 1) * w * fadeChart;
      peakDot.visible = peakLbl.visible = draw > 0.46; peakLbl.material.opacity = w * smooth((draw - 0.46) / 0.08) * (0.3 + 0.7 * fadeChart); peakDot.material.opacity = w * fadeChart;
      endDot.visible = endLbl.visible = endLeader.visible = draw > 0.985; endLbl.material.opacity = w * Math.max(fadeChart, 0.9); endDot.material.opacity = w * fadeChart; endLeader.material.opacity = 0.7 * w * fadeChart;
      const rb = (tt - 4.4) / 0.14; // staggered rebuild
      nodes.forEach((p, i) => {
        const a = smooth(rb - i * 1.0 + 0.0), k = a * w;
        nodeSprites[i].material.opacity = k * 0.7; coreSprites[i].material.opacity = k; nodeSprites[i].scale.setScalar(0.32 * (state.reduced ? 1 : 1 + 0.15 * Math.sin(time * 2 + i)));
      });
      edgeLines.forEach(({ l, a, b }) => { const k = smooth(rb - Math.max(a, b < 0 ? a : b) * 1.0 + 0.5); l.material.opacity = k * w * 0.55; });
      net.rotation.y = state.reduced ? 0 : Math.sin(time * 0.25) * 0.15;
    },
  };
})();

/* ---------- 06 · BUY / HOLD / SELL, with SELL lit red ---------- */
FX[5] = (() => {
  const g = new THREE.Group(); g.rotation.y = 5 * STEP;
  const mkChip = (text, lit) => canvasTex(512, 220, (ctx, W, H) => {
    const col = lit ? '#ff4455' : '#c9d2d8';
    ctx.shadowColor = lit ? '#ff2a3d' : '#3dff8b'; ctx.shadowBlur = lit ? 36 : 10;
    ctx.fillStyle = lit ? 'rgba(70,6,14,.75)' : 'rgba(8,20,15,.7)';
    const r = 34, x = 24, y = 24, w = W - 48, h = H - 48;
    ctx.beginPath(); ctx.moveTo(x + r, y); ctx.arcTo(x + w, y, x + w, y + h, r); ctx.arcTo(x + w, y + h, x, y + h, r); ctx.arcTo(x, y + h, x, y, r); ctx.arcTo(x, y, x + w, y, r); ctx.closePath(); ctx.fill();
    ctx.lineWidth = lit ? 7 : 3; ctx.strokeStyle = col; ctx.stroke();
    ctx.shadowBlur = lit ? 28 : 0; ctx.fillStyle = lit ? '#fff' : col; ctx.font = '900 96px Orbitron, sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText(text, W / 2, H / 2 + 6);
  });
  const chips = ['BUY', 'HOLD', 'SELL'].map((t, i) => {
    const pos = [new V3(-1.8, 1.75, 0.6), new V3(0.2, 3.0, 0.2), new V3(2.25, 0.85, 0.6)][i];
    const idle = new THREE.SpriteMaterial({ map: mkChip(t, false), transparent: true, depthWrite: false });
    const lit = new THREE.SpriteMaterial({ map: mkChip(t, true), transparent: true, depthWrite: false });
    const s = new THREE.Sprite(idle); s.position.copy(pos); s.scale.set(1.65, 1.65 * 220 / 512, 1); g.add(s);
    return { s, idle, lit, t, pos };
  });
  const sellGlow = glowSprite(0xff2a3d, 3.4, 0); sellGlow.position.copy(chips[2].pos).add(new V3(0, 0, -0.1)); g.add(sellGlow);
  const redRing = new THREE.Mesh(new THREE.TorusGeometry(2.45, 0.03, 8, 140), new THREE.MeshBasicMaterial({ color: 0xff3b4a, transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false })); g.add(redRing);
  const beams = chips.map((c) => { const l = new THREE.Line(new THREE.BufferGeometry().setFromPoints([c.pos.clone().setLength(2.2), c.pos.clone().setLength(c.pos.length() - 0.9)]), new THREE.LineBasicMaterial({ color: 0x3dff8b, transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false })); g.add(l); return l; });
  g.visible = false; scene.add(g);
  return {
    group: g,
    update(t, tin, w, time) {
      const tt = state.reduced ? 99 : tin;
      const ign = smoother((tt - 2.4) / 1.0), pulse = state.reduced ? 0.5 : 0.5 + 0.5 * Math.sin(time * 2.6);
      chips.forEach((c, i) => {
        const a = smooth((tt - 0.3 - i * 0.45) / 0.8);
        const isSell = c.t === 'SELL';
        c.s.material = isSell && ign > 0.5 ? c.lit : c.idle;
        c.s.material.opacity = w * a * (isSell ? 1 : lerp(1, 0.32, ign));
        const bob = state.reduced ? 0 : Math.sin(time * 0.9 + i * 2) * 0.07;
        c.s.position.set(c.pos.x, c.pos.y + bob, c.pos.z);
        c.s.scale.set(1.65, 1.65 * 220 / 512, 1);
        if (isSell) c.s.scale.multiplyScalar(1 + 0.08 * ign * (0.4 + pulse * 0.6));
        beams[i].material.opacity = w * a * (isSell ? 0 : 0.35 * lerp(1, 0.3, ign));
        if (isSell) beams[i].material.color.set(0xff3b4a), beams[i].material.opacity = w * a * 0.9 * ign;
      });
      sellGlow.material.opacity = w * ign * (0.5 + 0.35 * pulse);
      redRing.material.opacity = w * ign * (0.35 + 0.35 * pulse); redRing.scale.setScalar(1 + 0.04 * pulse);
      fxShared.red = Math.max(fxShared.red, w * ign * 0.95);
    },
  };
})();

/* =====================================================================
   Panels (CSS3D) and layout
   ===================================================================== */
const panelEls = [...document.querySelectorAll('#panels .panel')];
const panels = panelEls.map((el, i) => {
  el.setAttribute('role', 'group'); el.setAttribute('aria-roledescription', 'slide'); el.setAttribute('aria-label', `${i + 1} of ${N}: ${el.dataset.title}`);
  const obj = new CSS3DObject(el); cssScene.add(obj);
  return { el, obj, o: 0, i };
});
$('#panels').remove();

/* editable cover fields persist locally */
document.querySelectorAll('[data-key]').forEach((el) => {
  const saved = store.get('venom.' + el.dataset.key, null); if (saved) el.textContent = saved;
  el.addEventListener('input', () => store.set('venom.' + el.dataset.key, el.textContent.trim()));
  el.addEventListener('keydown', (e) => { e.stopPropagation(); if (e.key === 'Enter') { e.preventDefault(); el.blur(); } });
  el.addEventListener('pointerdown', (e) => e.stopPropagation());
});

const layout = { portrait: false, D: 11.5, ox: 0, oy: 0, vw: 1, vh: 1, fxScale: 1, cssK: 100 };
const camTarget = new V3();
const tmpV = new V3();

function poseCamera(theta, dR = 0, dH = 0) {
  const R = layout.D + dR, y = layout.D * 0.19 + dH;
  camera.position.set(Math.sin(theta) * R, y, Math.cos(theta) * R);
  camTarget.set(Math.cos(theta) * layout.ox, layout.oy, -Math.sin(theta) * layout.ox);
  camera.lookAt(camTarget);
  camera.updateMatrixWorld(true);
}

function doLayout() {
  const vw = window.innerWidth, vh = window.innerHeight, aspect = vw / vh;
  layout.vw = vw; layout.vh = vh;
  layout.portrait = aspect < 1.05;
  renderer.setSize(vw, vh, false); composer.setSize(vw, vh); cssRenderer.setSize(vw, vh);
  camera.aspect = aspect; camera.updateProjectionMatrix();
  const Hv = (d) => 2 * d * TAN;
  if (layout.portrait) {
    layout.D = clamp(5.2 / (2 * TAN * aspect), 12, 21);
    layout.ox = 0; layout.oy = -((0.5 - 0.26) * Hv(layout.D)); layout.fxScale = clamp(layout.D > 15 ? 0.6 : 0.8, 0.55, 1);
  } else {
    layout.D = 11.5; layout.fxScale = clamp(aspect / 1.55, 0.72, 1);
    layout.ox = (0.5 - 0.29) * Hv(layout.D) * aspect; layout.oy = -0.05 * Hv(layout.D);
  }
  FX.forEach((f) => { if (f) f.group.scale.setScalar(layout.fxScale); });
  coin.scale.setScalar(1);

  const u = layout.portrait ? clamp(Math.min(vw / 27, vh / 62), 9, 20) : clamp(Math.min(vw / 78, vh / 44), 8, 21);
  document.documentElement.style.setProperty('--u', u + 'px');
  const margin = Math.max(14, vw * 0.035);
  const W = layout.portrait ? vw - margin * 2 : clamp(vw * 0.4, 330, 680);
  const topLimit = layout.portrait ? vh * 0.42 : Math.max(60, vh * 0.09);
  const bottomLimit = layout.portrait ? vh - 98 : vh - Math.max(16, vh * 0.04);
  const availH = bottomLimit - topLimit;
  const dp = layout.D * 0.42, unitsPerPx = Hv(dp) / vh;
  layout.cssK = 1 / unitsPerPx;
  const saved = { angle: state.angle };
  panels.forEach((p) => {
    p.el.style.setProperty('--w', W + 'px'); p.el.style.setProperty('--fit', 1);
    let fit = 1, h = p.el.offsetHeight;
    for (let k = 0; k < 14 && h > availH && fit > 0.45; k++) { fit *= 0.93; p.el.style.setProperty('--fit', fit.toFixed(3)); h = p.el.offsetHeight; }
    const cx = layout.portrait ? vw / 2 : vw - margin - W / 2;
    const cy = layout.portrait ? topLimit + h / 2 : topLimit + availH / 2;
    poseCamera(p.i * STEP);
    const x = (cx / vw - 0.5) * Hv(dp) * aspect, y = (0.5 - cy / vh) * Hv(dp);
    tmpV.set(x, y, -dp).applyMatrix4(camera.matrixWorld);
    p.obj.position.copy(tmpV).multiplyScalar(layout.cssK); p.obj.quaternion.copy(camera.quaternion); p.obj.scale.setScalar(1);
  });
  // HUD sits under the coin on wide screens, centred on narrow ones
  $('.hud').style.left = layout.portrait ? '50%' : (29 + '%');
  state.angle = saved.angle;
}

/* =====================================================================
   Post-processing
   ===================================================================== */
const composer = new EffectComposer(renderer);
composer.addPass(new RenderPass(scene, camera));
const bloom = new UnrealBloomPass(new THREE.Vector2(512, 512), 0.38, 0.5, 0.92);
composer.addPass(bloom);
composer.addPass(new OutputPass());

/* =====================================================================
   Navigation
   ===================================================================== */
const els = { back: $('#back'), next: $('#next'), home: $('#home'), count: $('#count'), dots: $('#dots'), live: $('#live'), motion: $('#motion'), sound: $('#sound'), full: $('#full') };
const dotBtns = panels.map((p, i) => {
  const b = document.createElement('button'); b.type = 'button'; b.setAttribute('aria-label', `Go to section ${i + 1}: ${p.el.dataset.title}`); b.innerHTML = '<i></i>';
  b.addEventListener('click', () => { chirp('jump'); goTo(i); }); els.dots.appendChild(b); return b;
});

const enteredAt = new Array(N).fill(0);
let clockT = 0;
function goTo(i) {
  i = clamp(i, 0, N - 1);
  const base = i * STEP;
  const cur = state.anim ? state.anim.to : state.angle;
  const k = Math.round((cur - base) / (Math.PI * 2));
  const to = base + k * Math.PI * 2;
  const from = state.angle;
  const dist = Math.abs(to - from);
  if (i === state.index && dist < 1e-4) return;
  document.body.classList.add('moved');
  state.index = i; enteredAt[i] = clockT; fxTimes[i] = 0;
  state.anim = state.reduced ? null : { from, to, t0: clockT, dur: clamp(1.5 + (dist / STEP) * 0.55, 1.9, 3.4), dist };
  if (state.reduced) state.angle = to;
  updateHud();
}
function updateHud() {
  const n = String(state.index + 1).padStart(2, '0');
  els.count.innerHTML = `<span>${n}</span><small>/ 06</small>`;
  els.back.disabled = state.index === 0; els.next.disabled = state.index === N - 1;
  dotBtns.forEach((b, i) => b.setAttribute('aria-current', i === state.index ? 'true' : 'false'));
  panels.forEach((p) => { const on = p.i === state.index; p.el.toggleAttribute('inert', !on); p.el.setAttribute('aria-hidden', on ? 'false' : 'true'); });
  els.live.textContent = `Section ${state.index + 1} of ${N}: ${panels[state.index].el.dataset.title}`;
}
const next = () => goTo(state.index + 1), back = () => goTo(state.index - 1), home = () => goTo(0);

/* subtle electronic sounds — only for button clicks */
let actx = null;
function chirp(kind) {
  if (!state.sound) return;
  try {
    actx = actx || new (window.AudioContext || window.webkitAudioContext)();
    if (actx.state === 'suspended') actx.resume();
    const t0 = actx.currentTime, master = actx.createGain(); master.gain.value = 0.5; master.connect(actx.destination);
    const tone = (f0, f1, start, dur, type = 'sine', vol = 0.05) => {
      const o = actx.createOscillator(), g = actx.createGain(), f = actx.createBiquadFilter();
      f.type = 'lowpass'; f.frequency.value = 3200;
      o.type = type; o.frequency.setValueAtTime(f0, t0 + start); o.frequency.exponentialRampToValueAtTime(f1, t0 + start + dur);
      g.gain.setValueAtTime(0.0001, t0 + start); g.gain.exponentialRampToValueAtTime(vol, t0 + start + 0.012); g.gain.exponentialRampToValueAtTime(0.0001, t0 + start + dur);
      o.connect(f); f.connect(g); g.connect(master); o.start(t0 + start); o.stop(t0 + start + dur + 0.02);
    };
    if (kind === 'next') { tone(440, 990, 0, 0.16, 'triangle'); tone(880, 1760, 0.04, 0.12, 'sine', 0.025); }
    else if (kind === 'back') { tone(880, 392, 0, 0.16, 'triangle'); tone(1320, 660, 0.04, 0.12, 'sine', 0.02); }
    else if (kind === 'home') { tone(330, 330, 0, 0.09, 'triangle'); tone(495, 495, 0.08, 0.09, 'triangle'); tone(660, 660, 0.16, 0.14, 'triangle'); }
    else { tone(520, 780, 0, 0.1, 'triangle', 0.04); }
  } catch { /* audio unavailable */ }
}

document.addEventListener('click', (e) => { const b = e.target.closest && e.target.closest('button'); if (b && e.detail > 0) b.blur(); }, true); // mouse clicks shouldn't leave focus on a button
els.next.addEventListener('click', () => { chirp('next'); next(); });
els.back.addEventListener('click', () => { chirp('back'); back(); });
els.home.addEventListener('click', () => { chirp('home'); home(); });
panels[N - 1].el.querySelector('#restart').addEventListener('click', () => { chirp('home'); home(); });

window.addEventListener('keydown', (e) => {
  if (e.altKey || e.ctrlKey || e.metaKey) return;
  const t = e.target; if (t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))) return;
  const k = e.key, onButton = t && t.tagName === 'BUTTON';
  if (k === 'ArrowRight' || k === 'ArrowDown' || k === 'PageDown') { e.preventDefault(); next(); }
  else if ((k === ' ' || k === 'Enter') && !onButton) { e.preventDefault(); next(); }
  else if (k === 'ArrowLeft' || k === 'ArrowUp' || k === 'PageUp') { e.preventDefault(); back(); }
  else if (k === 'Home' || k === 'Escape') { e.preventDefault(); home(); }
  else if (k === 'End') { e.preventDefault(); goTo(N - 1); }
  else if (/^[1-6]$/.test(k)) goTo(Number(k) - 1);
  else if (k === 'f' || k === 'F') toggleFull();
});

let wheelLock = 0, touchX = null, touchY = null;
window.addEventListener('wheel', (e) => { const n = performance.now(); if (n < wheelLock || Math.abs(e.deltaY) < 24) return; wheelLock = n + 1100; e.deltaY > 0 ? next() : back(); }, { passive: true });
window.addEventListener('touchstart', (e) => { if (e.touches.length === 1) { touchX = e.touches[0].clientX; touchY = e.touches[0].clientY; } }, { passive: true });
window.addEventListener('touchend', (e) => {
  if (touchX === null) return; const t = e.changedTouches[0], dx = t.clientX - touchX, dy = t.clientY - touchY; touchX = touchY = null;
  if (Math.abs(dx) > 50 && Math.abs(dx) > Math.abs(dy) * 1.3) dx < 0 ? next() : back();
}, { passive: true });

function toggleFull() {
  try { if (document.fullscreenElement) document.exitFullscreen(); else document.documentElement.requestFullscreen?.(); } catch { /* not allowed */ }
}
els.full.addEventListener('click', toggleFull);
if (!document.documentElement.requestFullscreen) els.full.hidden = true;

function applyMotion(v, persist = true) {
  state.reduced = v; document.body.classList.toggle('reduced', v);
  els.motion.setAttribute('aria-pressed', String(v));
  if (v) { // settle any in-flight camera move immediately
    if (state.anim) { state.angle = state.anim.to; state.anim = null; }
    state.intro = 1; renderer.toneMappingExposure = 1;
  }
  if (persist) store.set('venom.reduced', v ? '1' : '0');
}
els.motion.addEventListener('click', () => { applyMotion(!state.reduced); chirp('jump'); });
mqReduce.addEventListener?.('change', (e) => { if (store.get('venom.reduced', null) === null) applyMotion(e.matches, false); });
function applySound() { els.sound.setAttribute('aria-pressed', String(state.sound)); }
els.sound.addEventListener('click', () => { state.sound = !state.sound; store.set('venom.sound', state.sound ? '1' : '0'); applySound(); chirp('jump'); });

/* =====================================================================
   Frame loop
   ===================================================================== */
const fxTimes = new Array(N).fill(0), fxWeight = new Array(N).fill(0);
let lastNow = performance.now();
const gSoft = new THREE.Color();

function frame() {
  const nowMs = performance.now(); const dt = Math.min((nowMs - lastNow) / 1000, 0.05); lastNow = nowMs; clockT += dt; const time = clockT;

  /* camera travel */
  let dR = 0, dH = 0;
  if (state.anim) {
    const a = state.anim, p = clamp((time - a.t0) / a.dur, 0, 1), e = smoother(p);
    state.angle = lerp(a.from, a.to, e);
    const bump = Math.sin(Math.PI * p); dR = bump * (1.6 + Math.min(a.dist / STEP, 3) * 0.6); dH = bump * (0.8 + Math.min(a.dist / STEP, 3) * 0.25);
    if (p >= 1) { state.angle = a.to; state.anim = null; }
  }
  if (!state.reduced) { dH += Math.sin(time * 0.35) * 0.08; dR += Math.sin(time * 0.23) * 0.12; }
  poseCamera(state.angle, dR, dH);

  /* intro: coin emerging from darkness */
  if (!state.reduced && state.intro < 1) {
    state.intro = clamp(state.intro + dt / 4.2, 0, 1);
    renderer.toneMappingExposure = lerp(0.02, 1, smoother(seg(state.intro, 0, 0.7)));
  } else if (state.intro >= 1) renderer.toneMappingExposure = 1;
  const emerge = state.reduced ? 1 : smoother(seg(state.intro, 0.05, 0.8));
  if (!state.ready && (state.reduced || state.intro > 0.35)) { state.ready = true; document.body.classList.add('ready'); }

  /* coin */
  fxShared.coinKick *= 0.9;
  const spinSpeed = 0.32 + (1 - emerge) * 1.4;
  if (state.reduced) { coinSpin.rotation.y = -0.38; coin.rotation.x = 0.06; }
  else { coinSpin.rotation.y += dt * spinSpeed; coin.rotation.x = Math.sin(time * 0.31) * 0.09; coin.position.y = Math.sin(time * 0.8) * 0.06; }
  coin.scale.setScalar((0.86 + 0.14 * emerge) * (1 + fxShared.coinKick));
  neonMat.emissiveIntensity = 1.1 + (state.reduced ? 0.1 : 0.18 * Math.sin(time * 1.4)) + fxShared.coinKick * 4;
  halo.material.opacity = 0.15 * emerge + fxShared.coinKick * 1.2;

  /* lights */
  const red = clamp(fxShared.red, 0, 1); fxShared.red *= 0.0; // recomputed by effects each frame
  const ang = state.reduced ? 0.6 : time * 0.55;
  accent.position.set(Math.cos(ang) * 5.4, 1 + Math.sin(ang * 0.7) * 1.8, 3.4 + Math.sin(ang) * 1.8);
  accent.position.applyAxisAngle(new V3(0, 1, 0), state.angle);
  accent.color.copy(GREEN).lerp(RED, redSmooth.v);
  accent.intensity = 34 * emerge + redSmooth.v * 16;
  keyLight.intensity = 1.3 * emerge; rimLight.intensity = 1.0 * emerge;
  redSmooth.v += (red - redSmooth.v) * (1 - Math.exp(-dt * 4));

  /* ambient motion */
  if (!state.reduced) { dust.rotation.y += dt * 0.012; chain.rotation.y += dt * 0.025; chainBlocks.forEach((b) => { b.rotation.x += dt * b.userData.spin; b.rotation.y += dt * b.userData.spin * 0.7; }); }
  emitter.update(dt, redSmooth.v * 0.8);
  emitter.pts.material.opacity = emerge;

  /* effects */
  for (let i = 0; i < N; i++) {
    const tw = i === state.index ? 1 : 0;
    fxWeight[i] += (tw - fxWeight[i]) * (1 - Math.exp(-dt * (state.reduced ? 12 : (tw ? 3.2 : 4.2))));
    if (fxWeight[i] < 0.003) fxWeight[i] = 0;
    const f = FX[i]; if (!f) continue;
    const on = fxWeight[i] > 0.003;
    f.group.visible = on;
    if (on) { fxTimes[i] += dt; f.update(time, fxTimes[i], fxWeight[i], time); }
  }
  pylons.forEach((p, i) => { const near = 1 - clamp(Math.abs(angDiff(state.angle, i * STEP + Math.PI)) / 1.4, 0, 1); p.beam.material.opacity = 0.18 + 0.4 * near; p.ring.material.opacity = 0.25 + 0.5 * near; p.num.material.opacity = 0.25 + 0.6 * near; });

  /* panels: fade by angular distance from the camera, so the next section "swings" into view */
  const intro = state.reduced ? 1 : smooth((state.intro - 0.36) / 0.3);
  panels.forEach((p) => {
    const d = Math.abs(angDiff(state.angle, p.i * STEP));
    let target = clamp(1 - d / 0.95, 0, 1); target = smooth(target);
    if (p.i === 0) target *= intro;
    p.o += (target - p.o) * (1 - Math.exp(-dt * (state.reduced ? 14 : 30)));
    const vis = p.o > 0.01;
    p.el.style.visibility = vis ? 'visible' : 'hidden'; p.el.style.opacity = p.o.toFixed(3);
    p.el.style.pointerEvents = p.i === state.index && p.o > 0.6 ? 'auto' : 'none';
  });

  composer.render(dt);
  cssCamera.position.copy(camera.position).multiplyScalar(layout.cssK); cssCamera.quaternion.copy(camera.quaternion);
  cssCamera.projectionMatrix.copy(camera.projectionMatrix); cssCamera.projectionMatrixInverse.copy(camera.projectionMatrixInverse); cssCamera.updateMatrixWorld(true);
  cssRenderer.render(cssScene, cssCamera);
  requestAnimationFrame(frame);
}
const redSmooth = { v: 0 };
function angDiff(a, b) { let d = (a - b) % (Math.PI * 2); if (d > Math.PI) d -= Math.PI * 2; if (d < -Math.PI) d += Math.PI * 2; return d; }

/* =====================================================================
   Boot
   ===================================================================== */
window.addEventListener('resize', doLayout);
applyMotion(state.reduced, false); applySound();
cssRenderer.render(cssScene, cssCamera); // attach panel elements to the DOM so their heights can be measured
doLayout(); updateHud();
if (state.reduced) { state.intro = 1; }
window.venom = { state, goTo, next, back, home, layout, time: () => clockT }; // handy for testing / presenting from the console
requestAnimationFrame(frame);
