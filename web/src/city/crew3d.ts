import * as THREE from 'three';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { Avatar, type Mood } from '../crew/Avatar.tsx';

/*
 * Crew in the town are the exact same artwork as their dashboard avatar: the Avatar SVG is drawn into a texture
 * and shown as a camera-facing figure standing in the 3D world, with a soft shadow and a few 3D props
 * (crate, box, blueprint) for what they're doing. Whatever angle you look from, you see their face.
 */

export type CrewMode = 'hammer' | 'walk' | 'carry' | 'read' | 'wave' | 'sit' | 'stuck';
export type CrewSpec = { shape: string; color: string; accessory: string; job: string; mood: Mood; mode: CrewMode };
type Mat = (c: string) => THREE.Material;

const PX = 256;
const texCache = new Map<string, THREE.CanvasTexture>();

/** The avatar SVG, rasterized once per look (shape, color, accessory, job, mood) and shared by every figure wearing it. */
export function avatarTexture(spec: Omit<CrewSpec, 'mode'>): THREE.CanvasTexture {
  const key = `${spec.shape}|${spec.color}|${spec.accessory}|${spec.job}|${spec.mood}`;
  const hit = texCache.get(key);
  if (hit) return hit;
  const canvas = document.createElement('canvas'); canvas.width = PX; canvas.height = PX;
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.NoColorSpace; // the scene runs without color management; keep the avatar's exact hex colors
  tex.anisotropy = 4;
  const svg = renderToStaticMarkup(createElement(Avatar, { shape: spec.shape, color: spec.color, accessory: spec.accessory, job: spec.job, mood: spec.mood, size: PX }))
    .replace('<svg', '<svg xmlns="http://www.w3.org/2000/svg"');
  const img = new Image();
  img.onload = () => { canvas.getContext('2d')!.drawImage(img, 0, 0, PX, PX); tex.needsUpdate = true; };
  img.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
  texCache.set(key, tex);
  return tex;
}

/** Figures read a little brighter than the lit world, so dim them at night to sit in the scene. */
export function setCrewNight(root: THREE.Object3D, dark: boolean) {
  root.traverse((o) => { if ((o as THREE.Sprite).isSprite && o.userData.avatar) ((o as THREE.Sprite).material as THREE.SpriteMaterial).color.setScalar(dark ? 0.72 : 1); });
}

/** Soft white radial blob; tinted per use through the material color. */
const glowTex = (() => {
  let t: THREE.CanvasTexture | null = null;
  return () => {
    if (t) return t;
    const c = document.createElement('canvas'); c.width = c.height = 128;
    const g = c.getContext('2d')!; const grd = g.createRadialGradient(64, 64, 0, 64, 64, 62);
    grd.addColorStop(0, 'rgba(255,255,255,1)'); grd.addColorStop(0.35, 'rgba(255,255,255,.55)'); grd.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = grd; g.fillRect(0, 0, 128, 128);
    return (t = new THREE.CanvasTexture(c));
  };
})();

const shadowTex = (() => {
  let t: THREE.CanvasTexture | null = null;
  return () => {
    if (t) return t;
    const c = document.createElement('canvas'); c.width = c.height = 64;
    const g = c.getContext('2d')!; const grd = g.createRadialGradient(32, 32, 2, 32, 32, 30);
    grd.addColorStop(0, 'rgba(20,30,40,.45)'); grd.addColorStop(1, 'rgba(20,30,40,0)');
    g.fillStyle = grd; g.fillRect(0, 0, 64, 64);
    return (t = new THREE.CanvasTexture(c));
  };
})();

/** `glow`: accent color for crew who are actively at work (turquoise) or waiting on you (red): a halo, a spotlight on the ground and, when hammering, sparks. */
export function buildCrew(spec: CrewSpec, m: Mat, opts: { dark?: boolean; glow?: string } = {}) {
  const S = 1.45; // world size of the avatar square (the body fills ~80% of it)
  const root = new THREE.Group();
  const body = new THREE.Group(); root.add(body);
  const mat = new THREE.SpriteMaterial({ map: avatarTexture(spec), transparent: true, alphaTest: 0.05, depthWrite: true });
  if (opts.dark) mat.color.setScalar(0.72);
  const fig = new THREE.Sprite(mat);
  fig.userData.avatar = true;
  fig.center.set(0.5, 0.06); // pivot at the feet (the SVG leaves a little room under the body for its own shadow)
  fig.scale.set(S, S, 1);
  body.add(fig);
  // soft contact shadow on the ground
  const shadow = new THREE.Mesh(new THREE.PlaneGeometry(0.9, 0.5), new THREE.MeshBasicMaterial({ map: shadowTex(), transparent: true, depthWrite: false }));
  shadow.rotation.x = -Math.PI / 2; shadow.position.y = 0.02; shadow.renderOrder = -1; root.add(shadow);

  // Working glow: a pulsing halo behind the figure and a pool of light at their feet.
  let halo: THREE.Sprite | null = null, pool: THREE.Mesh | null = null;
  const sparks: THREE.Sprite[] = [];
  if (opts.glow) {
    // additive light reads at night; on a bright day it washes out, so paint the halo as a colored glow instead
    const hm = new THREE.SpriteMaterial({ map: glowTex(), color: opts.glow, transparent: true, blending: opts.dark ? THREE.AdditiveBlending : THREE.NormalBlending, depthWrite: false, opacity: 0.8 });
    halo = new THREE.Sprite(hm); halo.center.set(0.5, 0.3); halo.scale.set(S * 1.9, S * 1.9, 1); halo.renderOrder = -1; body.add(halo);
    pool = new THREE.Mesh(new THREE.PlaneGeometry(2.4, 2.4), new THREE.MeshBasicMaterial({ map: glowTex(), color: opts.glow, transparent: true, blending: opts.dark ? THREE.AdditiveBlending : THREE.NormalBlending, depthWrite: false }));
    pool.rotation.x = -Math.PI / 2; pool.position.y = 0.03; pool.renderOrder = -1; root.add(pool);
    if (spec.mode === 'hammer' || spec.mode === 'carry' || spec.mode === 'walk') {
      for (let i = 0; i < 5; i++) {
        const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: glowTex(), color: i % 2 ? '#ffd84d' : '#ffffff', transparent: true, blending: THREE.AdditiveBlending, depthWrite: false }));
        sp.scale.setScalar(0.16); body.add(sp); sparks.push(sp);
      }
    }
  }
  const mesh = (geo: THREE.BufferGeometry, c: string, x = 0, y = 0, z = 0, parent: THREE.Object3D = root) => {
    const me = new THREE.Mesh(geo, m(c)); me.position.set(x, y, z); me.castShadow = true; parent.add(me); return me;
  };
  let seat = 0;
  if (spec.mode === 'sit') { mesh(new THREE.BoxGeometry(0.55, 0.3, 0.45), '#a8774c', 0, 0.15, -0.05); seat = 0.28; }
  if (spec.mode === 'carry') mesh(new THREE.BoxGeometry(0.42, 0.28, 0.34), '#c27a4a', 0, S * 0.98, 0, body);
  if (spec.mode === 'read') { const bp = mesh(new THREE.BoxGeometry(0.5, 0.02, 0.36), '#4a80d6', 0.05, 0.45, 0.35, body); bp.rotation.x = -0.6; }

  const ph = Math.random() * 10;
  const update = (t: number) => {
    const k = t + ph;
    let y = seat, sq = 0, rot = 0;
    switch (spec.mode) {
      case 'hammer': { const a = Math.abs(Math.sin(k * 2.6)); y += a * 0.07; sq = (1 - a) * 0.05; rot = Math.sin(k * 2.6) * 0.06; break; }
      case 'walk': case 'carry': { const b = Math.abs(Math.sin(k * 5)); y += b * 0.09; sq = (1 - b) * 0.06; break; }
      case 'read': rot = Math.sin(k * 0.7) * 0.05; break;
      case 'wave': y += Math.max(0, Math.sin(k * 4)) * 0.14; break;
      case 'sit': sq = Math.sin(k * 0.8) * 0.015; break;
      case 'stuck': rot = Math.sin(k * 1.5) * 0.08; break;
    }
    fig.position.y = y;
    fig.scale.set(S * (1 + sq), S * (1 - sq), 1);
    mat.rotation = rot;
    shadow.scale.setScalar(1 - Math.min(0.3, (y - seat) * 2));
    if (halo && pool) {
      const p = 0.5 + 0.5 * Math.sin(k * 3);
      halo.position.y = y; (halo.material as THREE.SpriteMaterial).opacity = (opts.dark ? 0.75 : 0.5) + (opts.dark ? 0.35 : 0.3) * p;
      halo.scale.set(S * (1.8 + 0.25 * p), S * (1.8 + 0.25 * p), 1);
      (pool.material as THREE.MeshBasicMaterial).opacity = 0.55 + 0.35 * p; pool.scale.setScalar(0.9 + 0.15 * p);
    }
    sparks.forEach((sp, i) => {
      const u = (k * 1.6 + i / sparks.length) % 1; // each spark: pop out from the hands, arc up and fade
      const a = i * 2.4;
      sp.position.set(Math.cos(a) * (0.25 + u * 0.45), S * 0.45 + u * 0.55 - u * u * 0.4, Math.sin(a) * 0.2 + 0.25);
      (sp.material as THREE.SpriteMaterial).opacity = (1 - u) * 0.95; sp.scale.setScalar(0.18 * (1 - u * 0.6));
    });
  };
  return { root, body, update, height: S * 0.95 + seat };
}
