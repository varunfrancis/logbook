import * as THREE from 'three';
import { ACCESSORY_COLOR, mix, SHAPES } from '../crew/shapes.ts';
import type { Mood } from '../crew/Avatar.tsx';

/*
 * Low-poly 3D crew characters. Same identity as the 2D avatar: body silhouette (lathed from the shape's profile),
 * signature color, personality accessory, job prop, and a face decal drawn with the same expressions.
 */

export type CrewMode = 'hammer' | 'walk' | 'carry' | 'read' | 'wave' | 'sit' | 'stuck';
export type CrewSpec = { shape: string; color: string; accessory: string; job: string; mood: Mood; mode: CrewMode };
type Mat = (c: string) => THREE.Material;

const HEIGHT: Record<string, number> = { pebble: 0.82, bun: 0.78, cube: 0.92, cloud: 0.9 };
const faceCache = new Map<string, THREE.CanvasTexture>();

/** Face decal: eyes (+ glasses / freckles), one look per mood. Drawn in the avatar's 100-unit space around the eyes. */
function faceTexture(mood: Mood, accessory: string): THREE.CanvasTexture {
  const key = `${mood}|${accessory}`;
  const hit = faceCache.get(key);
  if (hit) return hit;
  const c = document.createElement('canvas'); c.width = 256; c.height = 160;
  const g = c.getContext('2d')!;
  g.scale(4, 4); g.translate(-25, -22); // shows x 25..89, y 22..62 of the avatar box; eyes sit at y≈40
  const f = 40, ink = '#1d232c';
  g.fillStyle = ink; g.strokeStyle = ink; g.lineCap = 'round'; g.lineJoin = 'round';
  const rr = (x: number, y: number, w: number, h: number, r: number) => { g.beginPath(); g.roundRect(x, y, w, h, r); g.fill(); };
  const line = (pts: number[], w: number) => { g.lineWidth = w; g.beginPath(); g.moveTo(pts[0], pts[1]); for (let i = 2; i < pts.length; i += 2) g.lineTo(pts[i], pts[i + 1]); g.stroke(); };
  switch (mood) {
    case 'working': rr(35, f - 3, 8, 10, 3); rr(57, f - 3, 8, 10, 3); line([33, f - 9, 43, f - 7], 2.4); line([57, f - 7, 67, f - 9], 2.4); line([46, f + 14, 54, f + 14], 2.4); break;
    case 'needs': rr(33, f - 7, 11, 15, 4); rr(56, f - 7, 11, 15, 4); g.fillStyle = '#fff'; g.beginPath(); g.arc(37, f - 3, 2, 0, 7); g.arc(60, f - 3, 2, 0, 7); g.fill(); g.fillStyle = ink; g.beginPath(); g.arc(50, f + 15, 3, 0, 7); g.fill(); break;
    case 'break': rr(35, f, 9, 4.5, 2); rr(57, f, 9, 4.5, 2); line([33, f - 2, 45, f - 2], 2); line([55, f - 2, 67, f - 2], 2); g.lineWidth = 2.2; g.beginPath(); g.moveTo(46, f + 13); g.quadraticCurveTo(50, f + 17, 54, f + 13); g.stroke(); break;
    case 'stuck': g.lineWidth = 2.2; for (const x of [39, 61]) { g.beginPath(); g.arc(x, f, 5.5, 0, 7); g.stroke(); g.beginPath(); g.arc(x, f, 2, 0, 7); g.stroke(); } line([44, f + 15, 47, f + 12, 50, f + 15, 53, f + 18, 56, f + 15], 2.2); break;
    case 'shipped': line([33, f + 2, 39, f - 4, 45, f + 2], 3); line([55, f + 2, 61, f - 4, 67, f + 2], 3); g.beginPath(); g.moveTo(43, f + 10); g.quadraticCurveTo(50, f + 21, 57, f + 10); g.fill(); break;
    default: g.lineWidth = 2.6; g.beginPath(); g.moveTo(34, f); g.quadraticCurveTo(39, f + 4, 44, f); g.moveTo(56, f); g.quadraticCurveTo(61, f + 4, 66, f); g.stroke();
  }
  if (accessory === 'glasses') { g.strokeStyle = '#25303d'; g.lineWidth = 2.4; for (const x of [39, 61]) { g.beginPath(); g.arc(x, f, 9, 0, 7); g.stroke(); } line([48, f, 52, f], 2.4); }
  if (accessory === 'freckles') { g.fillStyle = '#00000055'; for (const [x, y] of [[28, f + 8], [32, f + 11], [68, f + 8], [72, f + 11]]) { g.beginPath(); g.arc(x, y, 1.4, 0, 7); g.fill(); } }
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.NoColorSpace;
  faceCache.set(key, tex);
  return tex;
}

const latheCache = new Map<string, THREE.BufferGeometry>();
function bodyGeometry(shape: string, H: number): THREE.BufferGeometry {
  const key = `${shape}|${H}`;
  let geo = latheCache.get(key);
  if (geo) return geo;
  const sh = SHAPES[shape] ?? SHAPES.bean;
  if (shape === 'cube') {
    geo = new THREE.BoxGeometry(0.86 * H, H, 0.7 * H);
    geo.translate(0, H / 2, 0);
  } else {
    const pts = sh.profile.map(([r, y]) => new THREE.Vector2(Math.max(0.001, r * H), (1 - y) * H));
    geo = new THREE.LatheGeometry(pts, shape === 'triangle' ? 3 : 9);
    if (shape === 'triangle') geo.rotateY(Math.PI / 6);
  }
  latheCache.set(key, geo);
  return geo;
}
/** Radius of the body at height fraction yFrac from the top. */
function radiusAt(shape: string, yFrac: number): number {
  const p = (SHAPES[shape] ?? SHAPES.bean).profile;
  if (shape === 'cube') return 0.35;
  for (let i = 1; i < p.length; i++) {
    if (yFrac <= p[i][1]) { const [r0, y0] = p[i - 1], [r1, y1] = p[i]; const k = (yFrac - y0) / Math.max(1e-6, y1 - y0); return r0 + (r1 - r0) * k; }
  }
  return p[p.length - 1][0];
}

export function buildCrew(spec: CrewSpec, m: Mat) {
  const sh = SHAPES[spec.shape] ?? SHAPES.bean;
  const H = 0.95 * (HEIGHT[spec.shape] ?? 1);
  const root = new THREE.Group();
  const body = new THREE.Group(); root.add(body);
  const mesh = (geo: THREE.BufferGeometry, c: string | THREE.Material, x = 0, y = 0, z = 0, parent: THREE.Object3D = body) => {
    const me = new THREE.Mesh(geo, typeof c === 'string' ? m(c) : c); me.position.set(x, y, z); me.castShadow = true; parent.add(me); return me;
  };
  const shade = mix(spec.color, 0.3, 0);
  // feet
  mesh(new THREE.SphereGeometry(0.09, 8, 6), '#34405a', -0.12, 0.05, 0.04);
  mesh(new THREE.SphereGeometry(0.09, 8, 6), '#34405a', 0.12, 0.05, 0.04);
  const torso = new THREE.Group(); torso.position.y = 0.08; body.add(torso);
  mesh(bodyGeometry(spec.shape, H), spec.color, 0, 0, 0, torso);
  // face decal on the front, at the avatar's eye height
  const yFrac = Math.min(0.75, Math.max(0.2, (sh.face - sh.top) / (94 - sh.top)));
  const fr = spec.shape === 'cube' ? 0.35 * H : radiusAt(spec.shape, yFrac) * H;
  const face = new THREE.Mesh(new THREE.PlaneGeometry(0.62 * H, 0.39 * H), new THREE.MeshBasicMaterial({ map: faceTexture(spec.mood, spec.accessory), transparent: true, depthWrite: false }));
  face.position.set(0, (1 - yFrac) * H - 0.02, fr + 0.012); torso.add(face);
  // hands
  const handR = new THREE.Group(); handR.position.set(radiusAt(spec.shape, 0.6) * H + 0.06, 0.42 * H, 0.04); torso.add(handR);
  const handL = new THREE.Group(); handL.position.set(-(radiusAt(spec.shape, 0.6) * H + 0.06), 0.42 * H, 0.04); torso.add(handL);
  mesh(new THREE.SphereGeometry(0.075, 8, 6), shade, 0, 0, 0, handR);
  mesh(new THREE.SphereGeometry(0.075, 8, 6), shade, 0, 0, 0, handL);
  const topY = H, neckY = (1 - Math.min(0.92, (sh.neck - sh.top) / (94 - sh.top))) * H;
  const neckR = radiusAt(spec.shape, Math.min(0.92, (sh.neck - sh.top) / (94 - sh.top))) * H;
  const acc = ACCESSORY_COLOR[spec.accessory] ?? '#e5484d';
  const hatJob = spec.job === 'builder' || spec.job === 'painter';
  // personality accessory
  if (spec.accessory === 'bow') {
    const l = mesh(new THREE.ConeGeometry(0.06, 0.11, 4), acc, -0.055, neckY, neckR + 0.03, torso); l.rotation.z = -Math.PI / 2;
    const r = mesh(new THREE.ConeGeometry(0.06, 0.11, 4), acc, 0.055, neckY, neckR + 0.03, torso); r.rotation.z = Math.PI / 2;
  } else if (spec.accessory === 'scarf') {
    const s = mesh(new THREE.TorusGeometry(neckR + 0.01, 0.045, 6, 14), acc, 0, neckY, 0, torso); s.rotation.x = Math.PI / 2;
    mesh(new THREE.BoxGeometry(0.07, 0.18, 0.04), acc, 0.08, neckY - 0.1, neckR + 0.02, torso);
  } else if (spec.accessory === 'headphones') {
    const band = mesh(new THREE.TorusGeometry(radiusAt(spec.shape, 0.2) * H + 0.05, 0.022, 6, 16, Math.PI), '#25303d', 0, topY * 0.72, 0, torso);
    band.rotation.y = Math.PI / 2;
    const rr = radiusAt(spec.shape, 0.3) * H + 0.04;
    mesh(new THREE.BoxGeometry(0.06, 0.13, 0.11), acc, rr, topY * 0.68, 0, torso);
    mesh(new THREE.BoxGeometry(0.06, 0.13, 0.11), acc, -rr, topY * 0.68, 0, torso);
  } else if (spec.accessory === 'beanie' && !hatJob) {
    const r = radiusAt(spec.shape, 0.12) * H + 0.06;
    mesh(new THREE.SphereGeometry(r, 10, 6, 0, Math.PI * 2, 0, Math.PI / 2), acc, 0, topY - 0.06, 0, torso);
    mesh(new THREE.SphereGeometry(0.05, 6, 5), mix(acc, 0.3, 0), 0, topY - 0.06 + r, 0, torso);
  }
  // job: hat + prop in the right hand
  const prop = new THREE.Group(); handR.add(prop);
  if (spec.job === 'builder') {
    const r = radiusAt(spec.shape, 0.1) * H + 0.07;
    mesh(new THREE.SphereGeometry(r, 10, 6, 0, Math.PI * 2, 0, Math.PI / 2), '#ffc928', 0, topY - 0.05, 0, torso);
    mesh(new THREE.CylinderGeometry(r + 0.05, r + 0.05, 0.025, 14), '#f0b400', 0, topY - 0.05, 0.02, torso);
    mesh(new THREE.BoxGeometry(0.04, 0.04, 0.3), '#8b5a2b', 0, 0, 0.14, prop);
    mesh(new THREE.BoxGeometry(0.09, 0.15, 0.09), '#6b7480', 0, -0.04, 0.3, prop);
  } else if (spec.job === 'painter') {
    const beret = mesh(new THREE.CylinderGeometry(0.2, 0.22, 0.06, 12), '#25303d', -0.04, topY - 0.01, 0, torso); beret.rotation.z = 0.25;
    mesh(new THREE.BoxGeometry(0.035, 0.035, 0.28), '#a16207', 0, 0, 0.13, prop);
    mesh(new THREE.ConeGeometry(0.035, 0.08, 6), '#e5484d', 0, 0, 0.3, prop).rotation.x = Math.PI / 2;
  } else if (spec.job === 'plumber') {
    mesh(new THREE.BoxGeometry(0.04, 0.04, 0.3), '#8a94a3', 0, 0, 0.14, prop);
    mesh(new THREE.TorusGeometry(0.05, 0.02, 4, 8, Math.PI * 1.4), '#8a94a3', 0, 0, 0.32, prop);
  } else if (spec.job === 'inspector') {
    mesh(new THREE.BoxGeometry(0.03, 0.03, 0.16), '#25303d', 0, 0, 0.07, prop);
    const lens = mesh(new THREE.TorusGeometry(0.07, 0.018, 6, 14), '#25303d', 0, 0, 0.22, prop); lens.rotation.y = Math.PI / 2;
  } else if (spec.job === 'librarian') {
    mesh(new THREE.BoxGeometry(0.26, 0.04, 0.2), '#3f8efc', -radiusAt(spec.shape, 0.6) * H - 0.06, 0.02, 0.14, handR);
  } else if (spec.job === 'scout') {
    mesh(new THREE.CylinderGeometry(0.035, 0.035, 0.1, 8), '#25303d', -0.04, 0, 0.04, prop).rotation.x = Math.PI / 2;
    mesh(new THREE.CylinderGeometry(0.035, 0.035, 0.1, 8), '#25303d', 0.04, 0, 0.04, prop).rotation.x = Math.PI / 2;
  }
  let extra: THREE.Object3D | null = null;
  if (spec.mode === 'read' && spec.job !== 'librarian') { extra = mesh(new THREE.BoxGeometry(0.4, 0.015, 0.28), '#4a80d6', 0, 0.45 * H, fr + 0.16, torso); extra.rotation.x = -0.5; prop.visible = false; }
  if (spec.mode === 'carry') { extra = mesh(new THREE.BoxGeometry(0.3, 0.2, 0.24), '#c27a4a', 0, topY + 0.14, 0, torso); prop.visible = false; }
  if (spec.mode === 'sit') { mesh(new THREE.BoxGeometry(0.42, 0.24, 0.34), '#a8774c', 0, 0.12, -0.1, root); body.position.y = 0.18; mesh(new THREE.CylinderGeometry(0.045, 0.045, 0.09, 8), '#ffffff', 0, 0.03, 0.06, handR); prop.visible = false; }
  if (spec.mode === 'wave') prop.visible = false;
  // stuck: a little rain cloud of their own
  let cloud: THREE.Group | null = null; const drops: THREE.Mesh[] = [];
  if (spec.mood === 'stuck') {
    cloud = new THREE.Group(); cloud.position.y = topY + 0.75; root.add(cloud);
    for (const [x, r] of [[-0.14, 0.13], [0.02, 0.17], [0.17, 0.12]] as const) mesh(new THREE.IcosahedronGeometry(r, 0), '#8a94a3', x, 0, 0, cloud);
    for (let i = 0; i < 4; i++) drops.push(mesh(new THREE.BoxGeometry(0.02, 0.08, 0.02), '#5a8fd6', -0.15 + i * 0.1, -0.2, 0, cloud));
  }
  const ph = Math.random() * 10;
  const update = (t: number) => {
    const k = t + ph;
    body.rotation.set(0, 0, 0); torso.rotation.set(0, 0, 0); torso.scale.set(1, 1, 1); handR.rotation.set(0, 0, 0); handL.position.y = 0.42 * H;
    switch (spec.mode) {
      case 'hammer': { const a = Math.abs(Math.sin(k * 2.6)); handR.rotation.x = -0.6 - a * 1.4; handR.position.y = 0.42 * H + a * 0.18; torso.scale.y = 1 - a * 0.04; break; }
      case 'walk': case 'carry': { const b = Math.abs(Math.sin(k * 5)); body.position.y = b * 0.08; torso.scale.set(1 + (1 - b) * 0.05, 1 - (1 - b) * 0.06, 1 + (1 - b) * 0.05); handR.position.y = 0.42 * H + Math.sin(k * 5) * 0.05; handL.position.y = 0.42 * H - Math.sin(k * 5) * 0.05; break; }
      case 'read': body.rotation.y = Math.sin(k * 0.7) * 0.25; torso.rotation.x = Math.sin(k * 1.2) * 0.05; break;
      case 'wave': handR.position.y = 0.42 * H + 0.35 + Math.sin(k * 8) * 0.06; handR.position.x = radiusAt(spec.shape, 0.6) * H + 0.12 + Math.sin(k * 8) * 0.05; body.position.y = Math.max(0, Math.sin(k * 4)) * 0.1; break;
      case 'sit': { const sip = Math.max(0, Math.sin(k * 0.8)) ** 4; handR.position.y = 0.42 * H + sip * 0.25; body.rotation.y = Math.sin(k * 0.3) * 0.15; break; }
      case 'stuck': body.rotation.z = Math.sin(k * 1.5) * 0.06; break;
    }
    if (cloud) { cloud.position.x = Math.sin(k * 0.8) * 0.05; drops.forEach((d, i) => { d.position.y = -0.15 - (((k * 1.4 + i * 0.27) % 1) * 0.5); }); }
  };
  return { root, body, update, height: topY + 0.1 };
}
