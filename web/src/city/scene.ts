import * as THREE from 'three';
import type { GraveEntry, ProjectView, SessionView, StateView } from '../../../daemon/types.ts';
import { buildCrew, type CrewMode } from './crew3d.ts';
import type { Mood } from '../crew/Avatar.tsx';
import { compact } from '../format.ts';

// Pastel colors as authored (matches the prototype); no linear-space conversion.
THREE.ColorManagement.enabled = false;

/*
 * The city: one lot per project on a grid (positions come from the daemon's stable spiral),
 * buildings whose look follows project state, and one builder per live session.
 * Everything is plain three.js, rebuilt per building only when that building's visual key changes.
 */

const LOT = 8, ROAD = 3, PITCH = LOT + ROAD, FH = 1.1, BASE = 0.24;
const PALETTE = ['#f4b183', '#9fd9c6', '#b8a7e8', '#f6d36b', '#9cc7f0', '#f5a3b5', '#a8d8a0', '#f2c38b', '#c6b8f0', '#8fd3d9'];
const STATE_DOT: Record<string, string> = { site: '#17c3c3', needs: '#e5484d', construction: '#f5c542', recent: '#2f9e66', done: '#8a9099', lot: '#a8794f' };
const LIFT = 1.6;

type Mode = CrewMode;
type Updater = (t: number, dt: number) => void;
type Label = { el: HTMLElement; obj: THREE.Object3D; dy: number; kind: 'bb' | 'tag' | 'fx' | 'chat'; pid: string };

function hash(s: string) { let h = 2166136261; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return h >>> 0; }
function rand(seed: number) { return () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; }; }
const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!));

function modeFor(s: SessionView): Mode {
  if (s.status === 'needs_input') return 'wave';
  if (s.status === 'idle') return 'sit';
  switch (s.actionKind) {
    case 'edit': return 'hammer';
    case 'run': return 'carry';
    case 'read': case 'web': return 'read';
    case 'delegate': return 'walk';
    default: return 'walk';
  }
}

export type CityOptions = { onSelect: (id: string | null) => void; onAgent?: (sessionId: string) => void; onHover?: (id: string | null) => void };

export class CityScene {
  private renderer: THREE.WebGLRenderer;
  private scene = new THREE.Scene();
  private cam = new THREE.OrthographicCamera(-1, 1, 1, -1, -400, 800);
  private target = new THREE.Vector3(0, 2, 0);
  private OFF = new THREE.Vector3(30, 26, 30);
  private zoom = 1;
  private viewSize = 40;
  private hemi = new THREE.HemisphereLight('#ffffff', '#9cc483', 0.62);
  private sun = new THREE.DirectionalLight('#fff1dc', 0.85);
  private mats = new Map<string, THREE.MeshStandardMaterial>();
  private winMats = new Set<THREE.MeshStandardMaterial>();
  private ground = new THREE.Group();
  private groundKey = '';
  private buildings = new Map<string, { group: THREE.Group; key: string; updaters: Updater[]; labels: Label[]; top: THREE.Object3D; state: string }>();
  private globalUpdaters: Updater[] = [];
  private labels: Label[] = [];
  private selected: string | null = null;
  private hovered: string | null = null;
  private bounds = { minX: -1, maxX: 1, minZ: -1, maxZ: 1 };
  private fitted = false;
  private raf = 0;
  private clock = new THREE.Clock();
  private reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
  private dark = false;
  private v = new THREE.Vector3();
  private ray = new THREE.Raycaster();
  private ndc = new THREE.Vector2();
  private disposeFns: (() => void)[] = [];
  private chatEls = new Map<string, HTMLElement>();
  private graveGroup: THREE.Group | null = null;
  private graveLabels: Label[] = [];
  private graveKey = '';
  private elapsed = 0;

  private container: HTMLElement;
  private labelLayer: HTMLElement;
  private opts: CityOptions;

  constructor(container: HTMLElement, labelLayer: HTMLElement, opts: CityOptions) {
    this.container = container; this.labelLayer = labelLayer; this.opts = opts;
    this.renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    // Keep the flat pastel look of the prototype (no sRGB output conversion).
    this.renderer.outputColorSpace = THREE.LinearSRGBColorSpace;
    container.appendChild(this.renderer.domElement);
    this.scene.add(this.hemi, this.sun, this.sun.target, this.ground);
    this.sun.castShadow = true;
    this.sun.shadow.mapSize.set(4096, 4096);
    this.sun.shadow.bias = -0.0008;
    this.sun.shadow.normalBias = 0.02;
    this.setTheme(false);
    this.bindInput();
    const ro = new ResizeObserver(() => this.resize());
    ro.observe(container);
    this.disposeFns.push(() => ro.disconnect());
    this.addCloudsAndTraffic();
    this.loop();
  }

  // ---------- public ----------
  setTheme(dark: boolean) {
    this.dark = dark;
    this.scene.background = new THREE.Color(dark ? '#1b2636' : '#d4ebf2');
    // three.js r155+ uses physical light units: these are the prototype's values × π.
    this.hemi.intensity = dark ? 1.0 : 2.0;
    this.hemi.color.set(dark ? '#8fa3e6' : '#ffffff');
    this.hemi.groundColor.set(dark ? '#3a4a3a' : '#9cc483');
    this.sun.intensity = dark ? 0.9 : 2.6;
    this.sun.color.set(dark ? '#b9c6ff' : '#fff1dc');
    for (const m of this.winMats) { m.emissive.set(dark ? '#ffc861' : '#000000'); m.emissiveIntensity = dark ? 0.55 : 0; }
  }

  setSelected(id: string | null) { this.selected = id; }

  setState(data: StateView, showLots: boolean) {
    const visible = data.projects.filter((p) => showLots || p.state !== 'lot');
    const byProject = new Map<string, SessionView[]>();
    for (const s of data.sessions) if (s.status !== 'ended' && !s.away && s.projectId) {
      if (!byProject.has(s.projectId)) byProject.set(s.projectId, []);
      byProject.get(s.projectId)!.push(s);
    }
    // ground
    const xs = visible.map((p) => p.lot[0]), zs = visible.map((p) => p.lot[1]);
    const b = xs.length ? { minX: Math.min(...xs), maxX: Math.max(...xs), minZ: Math.min(...zs), maxZ: Math.max(...zs) } : { minX: 0, maxX: 0, minZ: 0, maxZ: 0 };
    if (data.graveyard?.length) b.minX -= 1; // room for the graveyard at the edge of town
    const gk = JSON.stringify(b) + this.dark;
    if (gk !== this.groundKey) { this.groundKey = gk; this.bounds = b; this.buildGround(); this.graveKey = ''; }
    const grk = JSON.stringify((data.graveyard ?? []).map((e) => e.sessionId)) + this.groundKey;
    if (grk !== this.graveKey) { this.graveKey = grk; this.buildGraveyard(data.graveyard ?? []); }
    // buildings
    const seen = new Set<string>();
    for (const p of visible) {
      seen.add(p.id);
      const sessions = (byProject.get(p.id) ?? []).sort((a, c) => a.id.localeCompare(c.id));
      const key = JSON.stringify([p.state, p.floors, p.lot, p.name, p.prState, p.justShipped, p.stuck, p.checksFailing, p.justMerged, p.bricks, sessions.map((s) => [s.id, modeFor(s), s.helperActive, s.agent.title, !!s.stuck, !!s.chatter])]);
      const prev = this.buildings.get(p.id);
      if (prev && prev.key === key) continue;
      const celebrate = !!prev && (prev.state === 'site' || prev.state === 'needs') && !(p.state === 'site' || p.state === 'needs');
      if (prev) this.removeBuilding(p.id);
      this.addBuilding(p, sessions, key);
      if (celebrate) this.confetti(p);
    }
    for (const id of [...this.buildings.keys()]) if (!seen.has(id)) this.removeBuilding(id);
    for (const s of data.sessions) { const el = this.chatEls.get(s.id); if (el && s.chatter && el.textContent !== s.chatter) el.textContent = s.chatter; }
    if (!this.fitted && visible.length) { this.fitted = true; this.fit(); }
  }

  fit() {
    const { minX, maxX, minZ, maxZ } = this.bounds;
    this.target.set(((minX + maxX) / 2) * PITCH, 2, ((minZ + maxZ) / 2) * PITCH);
    const span = Math.max(maxX - minX + 1, maxZ - minZ + 1) * PITCH;
    this.viewSize = Math.max(30, span * 0.95);
    this.zoom = 1;
    this.placeCam();
    this.resize();
  }

  zoomBy(f: number) { this.zoom = Math.max(0.35, Math.min(4, this.zoom * f)); this.resize(); }

  focus(id: string) {
    const b = this.buildings.get(id);
    if (!b) return;
    b.group.getWorldPosition(this.v);
    this.target.set(this.v.x, 2, this.v.z);
    this.zoom = Math.max(this.zoom, 1.8);
    this.placeCam();
    this.resize();
  }

  dispose() {
    cancelAnimationFrame(this.raf);
    this.disposeFns.forEach((f) => f());
    for (const id of [...this.buildings.keys()]) this.removeBuilding(id);
    this.labelLayer.innerHTML = '';
    this.renderer.dispose();
    this.renderer.domElement.remove();
  }

  // ---------- camera / input ----------
  private resize() {
    const w = this.container.clientWidth || 1, h = this.container.clientHeight || 1, a = w / h;
    const vh = Math.max(this.viewSize / Math.max(a, 1) * 0.9, this.viewSize / a * 0.9, 24) / this.zoom;
    this.cam.left = (-vh * a) / 2; this.cam.right = (vh * a) / 2; this.cam.top = vh / 2; this.cam.bottom = -vh / 2;
    this.cam.updateProjectionMatrix();
    this.renderer.setSize(w, h);
  }

  private placeCam() {
    this.cam.position.copy(this.target).add(this.OFF);
    this.cam.lookAt(this.target);
    // keep the shadow camera centered on what we look at
    const span = Math.max(40, this.viewSize / this.zoom * 0.9);
    Object.assign(this.sun.shadow.camera, { left: -span, right: span, top: span, bottom: -span, near: 1, far: 160 });
    this.sun.shadow.camera.updateProjectionMatrix();
    this.sun.position.set(this.target.x + 18, 40, this.target.z + 10);
    this.sun.target.position.copy(this.target);
  }

  private pickAny(clientX: number, clientY: number): { kind: 'project' | 'agent'; id: string } | null {
    const r = this.renderer.domElement.getBoundingClientRect();
    this.ndc.set(((clientX - r.left) / r.width) * 2 - 1, -((clientY - r.top) / r.height) * 2 + 1);
    this.ray.setFromCamera(this.ndc, this.cam);
    const roots = [...this.buildings.values()].map((b) => b.group as THREE.Object3D);
    if (this.graveGroup) roots.push(this.graveGroup);
    const hit = this.ray.intersectObjects(roots, true)[0];
    let o: THREE.Object3D | null = hit?.object ?? null;
    while (o && !o.userData.pid && !o.userData.sid) o = o.parent;
    if (o?.userData.sid) return { kind: 'agent', id: o.userData.sid };
    if (o?.userData.pid) return { kind: 'project', id: o.userData.pid };
    return null;
  }
  private pick(clientX: number, clientY: number): string | null {
    const h = this.pickAny(clientX, clientY);
    return h?.kind === 'project' ? h.id : null;
  }

  private bindInput() {
    const el = this.renderer.domElement;
    el.style.touchAction = 'none';
    let drag: { x: number; y: number; sx: number; sy: number } | null = null;
    const pointers = new Map<number, { x: number; y: number }>();
    let pinch = 0;
    const down = (e: PointerEvent) => {
      pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (pointers.size === 2) { const [a, b] = [...pointers.values()]; pinch = Math.hypot(a.x - b.x, a.y - b.y); drag = null; return; }
      drag = { x: e.clientX, y: e.clientY, sx: e.clientX, sy: e.clientY };
      el.setPointerCapture(e.pointerId);
    };
    const move = (e: PointerEvent) => {
      if (pointers.has(e.pointerId)) pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (pointers.size === 2) {
        const [a, b] = [...pointers.values()];
        const d = Math.hypot(a.x - b.x, a.y - b.y);
        if (pinch) this.zoomBy(d / pinch);
        pinch = d;
        return;
      }
      if (!drag) {
        const id = this.pick(e.clientX, e.clientY);
        if (id !== this.hovered) { this.hovered = id; el.style.cursor = id ? 'pointer' : 'grab'; this.opts.onHover?.(id); }
        return;
      }
      const upp = (this.cam.top - this.cam.bottom) / (el.clientHeight || 1);
      const dx = (e.clientX - drag.x) * upp, dy = (e.clientY - drag.y) * upp;
      this.target.x += -dx * 0.707 - dy * 0.707 * 1.4;
      this.target.z += dx * 0.707 - dy * 0.707 * 1.4;
      const { minX, maxX, minZ, maxZ } = this.bounds;
      this.target.x = Math.max((minX - 1) * PITCH, Math.min((maxX + 1) * PITCH, this.target.x));
      this.target.z = Math.max((minZ - 1) * PITCH, Math.min((maxZ + 1) * PITCH, this.target.z));
      drag.x = e.clientX; drag.y = e.clientY;
      this.placeCam();
    };
    const up = (e: PointerEvent) => {
      pointers.delete(e.pointerId);
      if (pointers.size < 2) pinch = 0;
      if (drag && Math.hypot(e.clientX - drag.sx, e.clientY - drag.sy) < 5) {
        const h = this.pickAny(e.clientX, e.clientY);
        if (h?.kind === 'agent' && this.opts.onAgent) this.opts.onAgent(h.id); else this.opts.onSelect(h?.kind === 'project' ? h.id : null);
      }
      drag = null;
    };
    const wheel = (e: WheelEvent) => { e.preventDefault(); this.zoomBy(e.deltaY > 0 ? 0.9 : 1.1); };
    el.addEventListener('pointerdown', down);
    el.addEventListener('pointermove', move);
    el.addEventListener('pointerup', up);
    el.addEventListener('pointercancel', up);
    el.addEventListener('wheel', wheel, { passive: false });
    this.disposeFns.push(() => {
      el.removeEventListener('pointerdown', down); el.removeEventListener('pointermove', move);
      el.removeEventListener('pointerup', up); el.removeEventListener('pointercancel', up); el.removeEventListener('wheel', wheel);
    });
  }

  // ---------- primitives ----------
  private m(c: string) {
    let mat = this.mats.get(c);
    if (!mat) { mat = new THREE.MeshStandardMaterial({ color: c, roughness: 0.9, metalness: 0, flatShading: true }); this.mats.set(c, mat); }
    return mat;
  }
  private winMat(c: string) {
    const mat = this.m(c);
    if (!this.winMats.has(mat)) { this.winMats.add(mat); mat.emissive.set(this.dark ? '#ffc861' : '#000000'); mat.emissiveIntensity = this.dark ? 0.55 : 0; }
    return mat;
  }
  private bx(w: number, h: number, d: number, c: string | THREE.Material, x: number, y: number, z: number, parent: THREE.Object3D) {
    const me = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), typeof c === 'string' ? this.m(c) : c);
    me.position.set(x, y + h / 2, z); me.castShadow = me.receiveShadow = true; parent.add(me); return me;
  }
  private mesh(geo: THREE.BufferGeometry, c: string, x: number, y: number, z: number, parent: THREE.Object3D) {
    const me = new THREE.Mesh(geo, this.m(c)); me.position.set(x, y, z); me.castShadow = me.receiveShadow = true; parent.add(me); return me;
  }
  private tint(hex: string, amt: number) {
    return '#' + new THREE.Color(hex).lerp(new THREE.Color(amt > 0 ? '#ffffff' : '#1b2230'), Math.abs(amt)).getHexString();
  }
  private desat(hex: string) { const c = new THREE.Color(hex); const hsl = { h: 0, s: 0, l: 0 }; c.getHSL(hsl); c.setHSL(hsl.h, hsl.s * 0.45, Math.min(0.8, hsl.l)); return '#' + c.getHexString(); }
  private div(cls: string, html: string) { const d = document.createElement('div'); d.className = cls; d.innerHTML = html; return d; }
  private label(list: Label[], el: HTMLElement, obj: THREE.Object3D, dy: number, kind: Label['kind'], pid: string) {
    this.labelLayer.appendChild(el); const l = { el, obj, dy, kind, pid }; list.push(l); this.labels.push(l); return el;
  }
  private freeObject(o: THREE.Object3D) {
    o.traverse((c) => { if ((c as THREE.Mesh).geometry) (c as THREE.Mesh).geometry.dispose(); });
    o.removeFromParent();
  }

  // ---------- ground ----------
  private buildGround() {
    this.ground.children.slice().forEach((c) => this.freeObject(c));
    const { minX, maxX, minZ, maxZ } = this.bounds;
    const x0 = (minX - 0.5) * PITCH - ROAD / 2 - 2, x1 = (maxX + 0.5) * PITCH + ROAD / 2 + 2;
    const z0 = (minZ - 0.5) * PITCH - ROAD / 2 - 2, z1 = (maxZ + 0.5) * PITCH + ROAD / 2 + 2;
    const W = x1 - x0, D = z1 - z0, cx = (x0 + x1) / 2, cz = (z0 + z1) / 2;
    const g = this.ground;
    this.bx(W, 2.4, D, '#b8865a', cx, -2.7, cz, g);
    this.bx(W, 0.3, D, this.dark ? '#5f8a52' : '#9fcd7c', cx, -0.3, cz, g);
    const road = this.dark ? '#4d5663' : '#8e99a6', dash = this.dark ? '#c9c2a8' : '#f4f1e6';
    for (let gx = minX; gx <= maxX + 1; gx++) {
      const x = (gx - 0.5) * PITCH;
      this.bx(ROAD, 0.04, D - 4, road, x, 0, cz, g);
      for (let z = z0 + 3; z < z1 - 3; z += 2.2) this.bx(0.14, 0.02, 1, dash, x, 0.04, z, g);
    }
    for (let gz = minZ; gz <= maxZ + 1; gz++) {
      const z = (gz - 0.5) * PITCH;
      this.bx(W - 4, 0.045, ROAD, road, cx, 0, z, g);
      for (let x = x0 + 3; x < x1 - 3; x += 2.2) this.bx(1, 0.025, 0.14, dash, x, 0.045, z, g);
    }
    // trees along the island edge
    const r = rand(hash(this.groundKey));
    for (let x = x0 + 1; x < x1 - 1; x += 3 + r() * 3) { this.tree(x, z0 + 0.9, g, 0.7 + r() * 0.4); this.tree(x + 1.3, z1 - 0.9, g, 0.7 + r() * 0.4); }
    for (let z = z0 + 3; z < z1 - 3; z += 3 + r() * 3) { this.tree(x0 + 0.9, z, g, 0.7 + r() * 0.4); this.tree(x1 - 0.9, z + 1.1, g, 0.7 + r() * 0.4); }
  }

  private tree(x: number, z: number, parent: THREE.Object3D, s = 1) {
    const g = new THREE.Group(); g.position.set(x, 0, z); g.scale.setScalar(s); parent.add(g);
    this.bx(0.22, 0.6, 0.22, '#8a5a36', 0, 0, 0, g);
    this.mesh(new THREE.IcosahedronGeometry(0.62, 0), this.dark ? '#3f7d45' : '#5fae5b', 0, 1.05, 0, g);
    this.mesh(new THREE.IcosahedronGeometry(0.42, 0), this.dark ? '#4f9152' : '#77c26a', 0.18, 1.5, 0.1, g);
    return g;
  }

  private addCloudsAndTraffic() {
    const clouds: THREE.Group[] = [];
    for (let i = 0; i < 6; i++) {
      const g = new THREE.Group(); this.scene.add(g);
      [[0, 0, 0, 1], [0.9, 0.1, 0.2, 0.75], [-0.9, -0.05, -0.1, 0.7], [0.3, 0.45, 0, 0.6]].forEach(([x, y, z, r]) => {
        const s = this.mesh(new THREE.IcosahedronGeometry(r, 1), '#ffffff', x, y, z, g); s.receiveShadow = false;
      });
      g.userData.seed = i; clouds.push(g);
    }
    this.globalUpdaters.push((t) => {
      const { minX, maxX, minZ, maxZ } = this.bounds;
      const L = (maxX - minX + 3) * PITCH;
      clouds.forEach((c, i) => {
        c.visible = !this.dark;
        c.position.set((((i * 17 + t * 0.6) % L) + L) % L + (minX - 1.5) * PITCH, 15 + (i % 3) * 1.5, (minZ + ((i * 0.37) % 1) * (maxZ - minZ + 1)) * PITCH);
      });
    });
    const car = (color: string, lane: number, dir: number, speed: number, off: number) => {
      const g = new THREE.Group(); this.scene.add(g);
      this.bx(1.1, 0.32, 0.6, color, 0, 0.08, 0, g); this.bx(0.6, 0.26, 0.54, '#e8f4ff', -0.05, 0.4, 0, g);
      for (const [x, z] of [[-0.35, -0.3], [0.35, -0.3], [-0.35, 0.3], [0.35, 0.3]]) {
        const w = this.mesh(new THREE.CylinderGeometry(0.13, 0.13, 0.08, 10), '#2a2f36', x, 0.13, z, g); w.rotation.x = Math.PI / 2;
      }
      const light = this.bx(0.04, 0.1, 0.4, '#fff6c2', 0.56, 0.2, 0, g);
      g.rotation.y = dir > 0 ? 0 : Math.PI;
      this.globalUpdaters.push((t) => {
        const { minX, maxX } = this.bounds;
        const x0 = (minX - 0.5) * PITCH, L = (maxX - minX + 1) * PITCH;
        light.visible = this.dark;
        g.position.set(x0 + ((((t * speed * dir + off) % L) + L) % L), 0, (lane - 0.5) * PITCH + (dir > 0 ? 0.75 : -0.75));
      });
    };
    car('#e5484d', 0, 1, 2.2, 0); car('#3f8efc', 0, -1, 1.6, 14); car('#f5b301', 1, 1, 1.9, 30);
  }

  // ---------- buildings ----------
  private removeBuilding(id: string) {
    const b = this.buildings.get(id);
    if (!b) return;
    this.freeObject(b.group);
    for (const l of b.labels) { l.el.remove(); if (l.kind === 'chat') for (const [k, v] of this.chatEls) if (v === l.el) this.chatEls.delete(k); }
    this.labels = this.labels.filter((l) => !b.labels.includes(l));
    this.buildings.delete(id);
  }

  private addBuilding(p: ProjectView, sessions: SessionView[], key: string) {
    const outer = new THREE.Group();
    outer.position.set(p.lot[0] * PITCH, 0, p.lot[1] * PITCH);
    outer.userData.pid = p.id;
    this.scene.add(outer);
    const updaters: Updater[] = [];
    const labels: Label[] = [];
    const h = hash(p.id);
    const isLot = p.state === 'lot';
    this.bx(8.4, 0.18, 8.4, this.dark ? '#a8a294' : '#ece5d4', 0, 0, 0, outer);
    this.bx(7.6, 0.06, 7.6, isLot ? (this.dark ? '#5f8a52' : '#9fcd7c') : (this.dark ? '#6a9a5c' : '#a9d585'), 0, 0.18, 0, outer);
    const g = new THREE.Group(); g.position.y = BASE; outer.add(g);
    const top = new THREE.Object3D(); g.add(top);

    const live = p.state === 'site' || p.state === 'needs';
    const building = live || p.state === 'construction';
    const quiet = p.state === 'done';
    if (live) this.raise(outer, p.state === 'needs' ? '#e5484d' : '#17c3c3', updaters);
    let color = PALETTE[h % PALETTE.length];
    if (quiet) color = this.desat(color);
    const recent = p.state === 'recent';
    const w = 4.4 + ((h >> 4) % 3) * 0.4, d = 4.4 + ((h >> 6) % 3) * 0.4;
    const floors = Math.max(1, p.floors);
    let roofY = 0;

    if (isLot) {
      this.bx(5.5, 0.04, 4.6, '#c8a06e', 0, 0, 0, g);
      this.bx(0.12, 1.4, 0.12, '#8a5a36', 1.6, 0, 2.2, g);
      this.bx(1.5, 0.8, 0.08, '#fffaf0', 1.6, 0.95, 2.25, g);
      const r = rand(h);
      for (let i = 0; i < 3; i++) { const s = 0.2 + r() * 0.12; this.mesh(new THREE.DodecahedronGeometry(s, 0), '#9a9488', -2 + r() * 3, s * 0.6, -2 + r() * 3, g); }
      const sign = new THREE.Object3D(); sign.position.set(1.6, 1.62, 2.3); g.add(sign);
      this.label(labels, this.div('sale hidden-until-zoom', 'FOR SALE'), sign, 0, 'fx', p.id);
      top.position.set(0, 2.5, 0);
    } else if (building && floors <= 1 && sessions.length) {
      // Fresh project: just a foundation and low walls
      this.bx(5.2, 0.25, 5.2, '#cbc5ba', 0, 0, 0, g);
      this.bx(5.2, FH * 0.7, 0.3, color, 0, 0.25, -2.45, g); this.bx(0.3, FH * 0.45, 5.2, color, -2.45, 0.25, 0, g);
      for (let i = 0; i < 2; i++) for (let j = 0; j < 3; j++) this.bx(0.3, 0.2, 0.5, '#c0583d', 2.1 + i * 0.32, 0.25 + j * 0.2, 1.6, g);
      const mixer = new THREE.Group(); mixer.position.set(-2.6, 0.6, 3.1); g.add(mixer);
      const drum = this.mesh(new THREE.CylinderGeometry(0.35, 0.5, 0.8, 10), '#ef8e36', 0, 0.2, 0, mixer); drum.rotation.z = 1.1;
      this.bx(0.6, 0.1, 0.5, '#4e5660', 0, -0.4, 0, mixer);
      updaters.push((t) => { drum.rotation.y = t * 2; });
      roofY = 0.25;
      top.position.set(0, 2.6, 0);
    } else {
      const done = building ? floors - 1 : floors;
      this.tower(g, w, d, Math.max(1, done), color, quiet ? '#8f99a6' : '#3c5a7d');
      roofY = Math.max(1, done) * FH;
      if (building) {
        for (const [x, z] of [[-w / 2 + 0.2, -d / 2 + 0.2], [w / 2 - 0.2, -d / 2 + 0.2], [-w / 2 + 0.2, d / 2 - 0.2], [w / 2 - 0.2, d / 2 - 0.2]]) this.bx(0.32, FH * 0.9, 0.32, '#d9d4cc', x, roofY, z, g);
        this.bx(w, FH * 0.55, 0.3, color, 0, roofY, -d / 2 + 0.15, g);
        this.bx(0.3, FH * 0.35, d, color, -w / 2 + 0.15, roofY, 0, g);
        this.scaffold(g, w, d, Math.min(3, Math.max(1, done)));
        if (sessions.length >= 2) this.crane(g, w, d, roofY + 6.5, updaters);
        if (!live) this.barrier(g, d);
        top.position.set(0, roofY + (live ? 3.3 : 2.1), 0);
      } else {
        this.bx(w + 0.2, 0.16, d + 0.2, this.tint(color, -0.25), 0, roofY, 0, g);
        this.mesh(new THREE.CylinderGeometry(0.42, 0.42, 0.66, 12), this.tint(color, 0.45), -w / 4, roofY + 0.5, -d / 4, g);
        this.bx(0.7, 0.4, 0.5, '#c9ccd1', w / 5, roofY + 0.16, -d / 5, g);
        if (p.prState === 'merged' || p.prState === 'open') {
          this.bx(0.06, 1.8, 0.06, '#e9e6ef', w / 2 - 0.4, roofY + 0.16, d / 2 - 0.4, g);
          const flag = this.bx(0.9, 0.55, 0.04, p.prState === 'merged' ? '#2f9e66' : '#f5b301', w / 2 + 0.05, roofY + 1.33, d / 2 - 0.4, g);
          updaters.push((t) => { flag.rotation.y = Math.sin(t * 3) * 0.25; });
        }
        if (p.justShipped) {
          const stars: THREE.Mesh[] = [];
          for (let i = 0; i < 6; i++) {
            const s = this.mesh(new THREE.OctahedronGeometry(0.14, 0), '#ffd84d', Math.cos(i * 1.05) * (w / 2 + 0.6), roofY + 0.6 + (i % 3) * 0.5, Math.sin(i * 1.05) * (d / 2 + 0.6), g);
            s.castShadow = false; stars.push(s);
          }
          updaters.push((t) => stars.forEach((s, i) => { s.scale.setScalar(0.3 + (Math.sin(t * 2 + i * 1.3) + 1) / 2); s.rotation.y = t; }));
        }
        if (recent) this.bunting(g, w, d, roofY + 0.16, updaters);
        top.position.set(0, roofY + (p.prState ? 2.3 : 1.3), 0);
      }
      const r = rand(h + 7);
      if (!building && r() > 0.3) this.tree(3.2, 3.2, g, 0.75 + r() * 0.2);
      if (!building && r() > 0.5) this.tree(-3.2, 3.1, g, 0.7);
    }

    // builders
    const slots = this.slots(w, d, roofY, building && floors > 1 ? Math.min(3, Math.max(1, floors - 1)) : 0);
    const used = new Set<number>();
    sessions.forEach((s, i) => {
      const mode = modeFor(s);
      const pref: Record<Mode, number[]> = { hammer: [0, 4, 6], walk: [1, 7, 5], read: [2, 6, 5], carry: [3, 7, 5], wave: [5, 8, 6], sit: [8, 9, 5, 6], stuck: [0, 4, 6] };
      let idx = pref[mode].find((k) => !used.has(k) && slots[k]);
      if (idx === undefined) idx = slots.findIndex((sl, k) => sl && !used.has(k));
      if (idx === -1 || idx === undefined) idx = 9 + i;
      used.add(idx);
      const slot = slots[idx] ?? { pos: [(i % 3) - 1, 0, d / 2 + 2.2] as [number, number, number], face: Math.PI / 4 };
      this.builder(g, p.id, s, mode, slot, updaters, labels);
    });

    // weather and events
    if (p.stuck) this.rainCloud(g, (live || building ? roofY + 4.2 : roofY + 3), updaters);
    if (p.checksFailing && !isLot) this.fire(g, roofY, w, d, updaters);
    if (p.justMerged && !isLot) this.fireworks(g, roofY + 2, updaters);

    // billboard
    const pr = p.prState === 'merged' ? '<span class="pr merged">merged</span>' : p.prState === 'open' ? '<span class="pr open">PR open</span>' : '';
    const crew = live ? `<span class="crew">${p.state === 'needs' ? 'hand raised' : `${sessions.length} on site`}</span>` : '';
    const bb = this.div('bb', `<span class="d" style="background:${STATE_DOT[p.state]}"></span><b>${esc(p.name)}</b>${crew}${p.bricks ? `<span class="tok">${compact(p.bricks)} bricks</span>` : ''}${pr}`);
    bb.dataset.state = p.state;
    if (live) { const leader = document.createElement('i'); leader.className = 'leader'; bb.appendChild(leader); }
    bb.onclick = () => this.opts.onSelect(p.id);
    bb.onpointerenter = () => { this.hovered = p.id; };
    this.label(labels, bb, top, 0, 'bb', p.id);

    this.buildings.set(p.id, { group: outer, key, updaters, labels, top, state: p.state });
  }

  /** Lifts a lot with crew on site onto a lit plinth, with a pulsing ring on the street below. */
  private raise(outer: THREE.Group, accent: string, updaters: Updater[]) {
    const plinth = this.bx(8.4, 1, 8.4, this.tint(accent, 0.55), 0, 0, 0, outer);
    const rimMat = new THREE.MeshBasicMaterial({ color: accent, transparent: true });
    const rim = new THREE.Group(); outer.add(rim);
    for (const [w, d, x, z] of [[8.6, 0.12, 0, 4.24], [8.6, 0.12, 0, -4.24], [0.12, 8.6, 4.24, 0], [0.12, 8.6, -4.24, 0]] as const) {
      const bar = new THREE.Mesh(new THREE.BoxGeometry(w, 0.14, d), rimMat); bar.position.set(x, -0.05, z); rim.add(bar);
    }
    const ringMat = new THREE.MeshBasicMaterial({ color: accent, transparent: true, opacity: 0.5, side: THREE.DoubleSide, depthWrite: false });
    const ring = new THREE.Mesh(new THREE.RingGeometry(5.6, 6.2, 48), ringMat); ring.rotation.x = -Math.PI / 2; outer.add(ring);
    outer.position.y = 0;
    updaters.push((t, dt) => {
      outer.position.y += (LIFT - outer.position.y) * Math.min(1, dt * 2.5);
      const y = outer.position.y;
      plinth.scale.y = Math.max(0.001, y); plinth.position.y = -y / 2;
      ring.position.y = -y + 0.06;
      const k = (t * 0.6) % 1;
      ring.scale.setScalar(1 + k * 0.35); ringMat.opacity = 0.55 * (1 - k);
      rimMat.opacity = 0.45 + 0.55 * (0.5 + 0.5 * Math.sin(t * 5)); // blink
    });
  }

  /** Striped roadworks barrier in front of a site with no crew right now. */
  private barrier(parent: THREE.Object3D, d: number) {
    const z = d / 2 + 2.3;
    this.bx(0.1, 0.6, 0.1, '#e8e4dc', -1.2, 0, z, parent); this.bx(0.1, 0.6, 0.1, '#e8e4dc', 1.2, 0, z, parent);
    for (let i = 0; i < 6; i++) this.bx(0.42, 0.22, 0.08, i % 2 ? '#ffffff' : '#ff7a1a', -1.05 + i * 0.42, 0.42, z, parent);
    this.mesh(new THREE.ConeGeometry(0.16, 0.45, 10), '#ff7a1a', 2, 0.22, z - 0.2, parent);
  }

  /** Bunting along the roof edges of a just-completed building. */
  private bunting(parent: THREE.Object3D, w: number, d: number, y: number, updaters: Updater[]) {
    const cols = ['#ef4444', '#f5b301', '#3f8efc', '#2f9e66', '#f472b6'];
    const flags: THREE.Mesh[] = [];
    const top = y + 0.75;
    this.bx(0.05, 0.8, 0.05, '#e9e6ef', -w / 2, y, d / 2, parent); this.bx(0.05, 0.8, 0.05, '#e9e6ef', w / 2, y, d / 2, parent); this.bx(0.05, 0.8, 0.05, '#e9e6ef', w / 2, y, -d / 2, parent);
    const edge = (ax: number, az: number, bx2: number, bz: number) => {
      const n = 8;
      for (let i = 0; i < n; i++) {
        const u = (i + 0.5) / n, sag = Math.sin(u * Math.PI) * 0.18;
        const f = new THREE.Mesh(new THREE.ConeGeometry(0.11, 0.26, 3), this.m(cols[flags.length % cols.length]));
        f.rotation.x = Math.PI; f.position.set(ax + (bx2 - ax) * u, top - sag - 0.12, az + (bz - az) * u);
        f.castShadow = true; parent.add(f); flags.push(f);
      }
    };
    edge(-w / 2, d / 2, w / 2, d / 2);
    edge(w / 2, d / 2, w / 2, -d / 2);
    updaters.push((t) => flags.forEach((f, i) => { f.rotation.z = Math.sin(t * 3 + i) * 0.15; }));
  }

  private tower(parent: THREE.Object3D, w: number, d: number, floors: number, color: string, win: string) {
    const g = new THREE.Group(); parent.add(g);
    this.bx(w, floors * FH, d, color, 0, 0, 0, g);
    const ledge = this.tint(color, 0.35), wm = this.winMat(win);
    for (let i = 0; i < floors; i++) {
      this.bx(w + 0.12, 0.08, d + 0.12, ledge, 0, (i + 1) * FH - 0.06, 0, g);
      for (let k = -1; k <= 1; k++) {
        this.bx(0.06, 0.46, 0.62, wm, w / 2 + 0.02, i * FH + 0.3, (k * d) / 3.2, g);
        this.bx(0.62, 0.46, 0.06, wm, (k * w) / 3.2, i * FH + 0.3, d / 2 + 0.02, g);
      }
    }
    return g;
  }

  private scaffold(parent: THREE.Object3D, w: number, d: number, levels: number) {
    const pole = '#9aa3ad', plank = '#c99257', o = 0.55, H = levels * FH + 0.6;
    for (const z of [-d / 2 - o, 0, d / 2 + o]) this.bx(0.07, H, 0.07, pole, w / 2 + o, 0, z, parent);
    for (const x of [-w / 2 - o, 0]) this.bx(0.07, H, 0.07, pole, x, 0, d / 2 + o, parent);
    for (let L = 1; L <= levels; L++) {
      const y = L * FH;
      this.bx(0.6, 0.06, d + 2 * o, plank, w / 2 + o - 0.05, y - 0.06, 0, parent);
      this.bx(w + 2 * o, 0.06, 0.6, plank, 0, y - 0.06, d / 2 + o - 0.05, parent);
      this.bx(0.05, 0.05, d + 2 * o, pole, w / 2 + o + 0.25, y + 0.5, 0, parent);
      this.bx(w + 2 * o, 0.05, 0.05, pole, 0, y + 0.5, d / 2 + o + 0.25, parent);
    }
  }

  private crane(p: THREE.Object3D, w: number, d: number, H: number, updaters: Updater[]) {
    const cx = -w / 2 - 0.9, cz = -d / 2 - 0.9;
    this.bx(1.2, 0.3, 1.2, '#a9a39a', cx, 0, cz, p);
    for (const [dx, dz] of [[-0.22, -0.22], [0.22, -0.22], [-0.22, 0.22], [0.22, 0.22]]) this.bx(0.08, H, 0.08, '#f2b705', cx + dx, 0, cz + dz, p);
    for (let y = 0.6; y < H; y += 0.9) this.bx(0.52, 0.06, 0.52, '#e0a400', cx, y, cz, p);
    this.bx(0.8, 0.6, 0.7, '#f2b705', cx + 0.3, H, cz, p);
    this.bx(0.06, 0.4, 0.5, '#9cd3ff', cx + 0.71, H + 0.12, cz, p);
    const jib = new THREE.Group(); jib.position.set(cx, H + 0.6, cz); p.add(jib);
    this.bx(9, 0.28, 0.28, '#f2b705', 2, 0, 0, jib);
    for (let x = -2.2; x < 6.4; x += 0.6) this.bx(0.05, 0.28, 0.3, '#e0a400', x, 0.02, 0, jib);
    this.bx(1.1, 0.7, 0.7, '#7d8794', -2.2, -0.5, 0, jib);
    const trolley = new THREE.Group(); jib.add(trolley);
    this.bx(0.4, 0.16, 0.4, '#59616b', 0, -0.16, 0, trolley);
    const cable = this.bx(0.03, 1, 0.03, '#3a3f46', 0, 0, 0, trolley);
    const load = new THREE.Group(); trolley.add(load);
    this.bx(0.9, 0.1, 0.7, '#a8774c', 0, 0, 0, load);
    for (let i = 0; i < 3; i++) for (let j = 0; j < 2; j++) this.bx(0.26, 0.16, 0.3, '#c0583d', -0.3 + i * 0.3, 0.1, -0.17 + j * 0.34, load);
    const ph = Math.random() * 10;
    updaters.push((t) => {
      const tt = t + ph;
      jib.rotation.y = -0.8 + Math.sin(tt * 0.35) * 0.85;
      trolley.position.x = 4 + Math.sin(tt * 0.5) * 1.3;
      const drop = Math.max(1.5, H - 6 + (Math.sin(tt * 0.7) + 1) * 2.4);
      load.position.y = -drop; cable.scale.y = drop; cable.position.y = -drop / 2;
    });
  }

  private slots(w: number, d: number, roofY: number, levels: number) {
    type Slot = { pos: [number, number, number]; face: number; walk?: [[number, number, number], [number, number, number]] } | null;
    const L1 = levels >= 1 ? FH : 0, L2 = levels >= 2 ? 2 * FH : L1;
    const sx = w / 2 + (levels ? 0.85 : 1.4), sz = d / 2 + (levels ? 0.85 : 1.4);
    const s: Slot[] = [
      { pos: [sx, L1, 0.6], face: -Math.PI / 2 },                                                  // 0 wall, +x face
      { pos: [0, L2, sz], face: 0, walk: [[-w / 2 + 0.6, L2, sz], [w / 2 - 0.6, L2, sz]] },          // 1 plank walk, +z face
      roofY > 0.5 ? { pos: [0.6, roofY, 0.4], face: 0.6 } : { pos: [-1.2, 0, d / 2 + 2], face: 0.6 }, // 2 roof / blueprint
      { pos: [w / 2 + 1.9, 0, 0], face: 0, walk: [[w / 2 + 1.9, 0, -d / 2], [w / 2 + 1.9, 0, d / 2 - 0.2]] }, // 3 ground carry
      { pos: [-0.9, L1, sz], face: Math.PI },                                                     // 4 wall, +z face
      { pos: [1.2, L1, sz], face: Math.PI / 4 },                                                  // 5 front, facing camera
      { pos: [sx, levels >= 3 ? 3 * FH : L1, -1.1], face: -Math.PI / 2 },                          // 6 wall, high
      { pos: [0, 0, d / 2 + 2], face: Math.PI / 2, walk: [[-w / 2, 0, d / 2 + 2.1], [w / 2, 0, d / 2 + 2.1]] }, // 7 street walk
      { pos: [-2.4, 0, d / 2 + 2.3], face: Math.PI / 4 },                                          // 8 bench
      { pos: [-3.2, 0, 0.6], face: Math.PI / 3 },                                                 // 9 side bench
    ];
    return s;
  }

  private builder(parent: THREE.Object3D, pid: string, s: SessionView, mode: Mode, slot: { pos: [number, number, number]; face: number; walk?: [[number, number, number], [number, number, number]] }, updaters: Updater[], labels: Label[]) {
    if ((mode === 'walk' || mode === 'carry') && !slot.walk) mode = 'hammer';
    const a = s.agent;
    const mood: Mood = s.status === 'needs_input' ? 'needs' : s.stuck ? 'stuck' : s.status === 'idle' ? 'break' : 'working';
    const crew = buildCrew({ shape: a.shape, color: a.color, accessory: a.accessory, job: a.job, mood, mode: s.stuck && mode !== 'wave' ? 'stuck' : mode }, (c) => this.m(c));
    const g = crew.root;
    g.position.set(...slot.pos); g.rotation.y = mode === 'wave' || mode === 'sit' ? Math.PI / 4 : slot.face; g.scale.setScalar(a.role === 'helper' ? 0.95 : 1.35);
    g.userData.sid = s.id;
    parent.add(g);
    // helpers: a half-size copy of the agent tagging along
    let helper: ReturnType<typeof buildCrew> | null = null;
    if (s.helperActive) {
      helper = buildCrew({ shape: a.shape, color: a.color, accessory: a.accessory, job: 'none', mood: 'working', mode: 'walk' }, (c) => this.m(c));
      helper.root.scale.setScalar(0.62); helper.root.userData.sid = s.id; parent.add(helper.root);
    }
    const anchor = new THREE.Object3D(); anchor.position.y = crew.height + 0.25; g.add(anchor);
    this.label(labels, this.div('tag', esc(a.title)), anchor, 0.42, 'tag', pid);
    if (mode === 'wave') this.label(labels, this.div('bubble', '!'), anchor, 0, 'fx', pid);
    if (s.chatter) {
      const chat = this.div('chat', esc(s.chatter));
      chat.dataset.seed = String(hash(s.id) % 997);
      this.label(labels, chat, anchor, 0.95, 'chat', pid);
      this.chatEls.set(s.id, chat);
    }
    const ph = (hash(s.id) % 1000) / 100;
    const pa = slot.walk ? new THREE.Vector3(...slot.walk[0]) : null, pb = slot.walk ? new THREE.Vector3(...slot.walk[1]) : null;
    updaters.push((t) => {
      const k = t + ph;
      if ((mode === 'walk' || mode === 'carry') && pa && pb) {
        const u = (Math.sin(k * 0.55) + 1) / 2, dir = Math.cos(k * 0.55);
        g.position.lerpVectors(pa, pb, u);
        const dx = pb.x - pa.x, dz = pb.z - pa.z;
        g.rotation.y = Math.atan2(dir > 0 ? dx : -dx, dir > 0 ? dz : -dz);
      }
      crew.update(t);
      if (helper) {
        helper.root.position.set(g.position.x + Math.cos(k * 1.1) * 1.1, g.position.y, g.position.z + Math.sin(k * 1.1) * 1.1);
        helper.root.rotation.y = -k * 1.1 + Math.PI;
        helper.update(t * 1.3);
      }
    });
    return g;
  }

  /** Grey rain cloud over a building whose crew is stuck. */
  private rainCloud(parent: THREE.Object3D, y: number, updaters: Updater[]) {
    const c = new THREE.Group(); c.position.set(0, y, 0); parent.add(c);
    for (const [x, z, r] of [[-0.9, 0, 0.7], [0, 0.2, 0.95], [0.9, -0.1, 0.65], [0.3, -0.5, 0.6]] as const) {
      const s = this.mesh(new THREE.IcosahedronGeometry(r, 1), '#7d8796', x, 0, z, c); s.castShadow = false;
    }
    const drops: THREE.Mesh[] = [];
    for (let i = 0; i < 14; i++) { const d = this.bx(0.04, 0.22, 0.04, '#5a8fd6', -1.2 + (i % 7) * 0.4, -0.6, -0.4 + Math.floor(i / 7) * 0.7, c); d.castShadow = false; drops.push(d); }
    updaters.push((t) => { c.position.x = Math.sin(t * 0.5) * 0.3; drops.forEach((d, i) => { d.position.y = -0.5 - (((t * 1.2 + i * 0.137) % 1) * (y - 0.5)); }); });
  }

  /** Small flickering fire on the roof while the last check failed. */
  private fire(parent: THREE.Object3D, y: number, w: number, d: number, updaters: Updater[]) {
    const f = new THREE.Group(); f.position.set(w / 4, y, d / 4); parent.add(f);
    const outer = this.mesh(new THREE.ConeGeometry(0.42, 1.1, 7), '#ff7a1a', 0, 0.55, 0, f);
    const inner = this.mesh(new THREE.ConeGeometry(0.24, 0.7, 7), '#ffd84d', 0, 0.38, 0.05, f);
    (outer.material as THREE.MeshStandardMaterial).emissive?.set('#ff5a00');
    updaters.push((t) => { outer.scale.set(1 + Math.sin(t * 13) * 0.08, 1 + Math.sin(t * 17) * 0.15, 1); inner.scale.y = 1 + Math.sin(t * 21) * 0.2; f.rotation.y = t * 2; });
  }

  /** Fireworks over a building whose work was just approved and went live. */
  private fireworks(parent: THREE.Object3D, y: number, updaters: Updater[]) {
    const colors = ['#ff7aa8', '#ffd84d', '#3f8efc', '#17c3c3', '#9b6bff'];
    const bursts = [0, 1, 2].map((i) => {
      const g = new THREE.Group(); parent.add(g);
      const sparks = Array.from({ length: 22 }, (_, j) => {
        const m = new THREE.Mesh(new THREE.SphereGeometry(0.07, 4, 3), new THREE.MeshBasicMaterial({ color: colors[(i + j) % colors.length], transparent: true }));
        g.add(m); const a = (j / 22) * Math.PI * 2, b = (j % 5) * 0.5 - 1;
        return { m, v: new THREE.Vector3(Math.cos(a) * Math.cos(b), Math.sin(b) + 0.4, Math.sin(a) * Math.cos(b)) };
      });
      return { g, sparks, off: i * 0.9, x: (i - 1) * 2.2 };
    });
    updaters.push((t) => bursts.forEach((b) => {
      const k = ((t + b.off) % 2.7) / 2.7;
      b.g.position.set(b.x, y + 2 + k * 0.5, (b.off - 1) * 0.8);
      b.sparks.forEach((s) => { s.m.position.copy(s.v).multiplyScalar(k * 2.4); s.m.position.y -= k * k * 1.2; (s.m.material as THREE.MeshBasicMaterial).opacity = 1 - k; });
    }));
  }

  /** A fenced plot at the edge of town with a tombstone for each scrapped or unfinished shift. */
  private buildGraveyard(graves: GraveEntry[]) {
    if (this.graveGroup) { this.freeObject(this.graveGroup); for (const l of this.graveLabels) l.el.remove(); this.labels = this.labels.filter((l) => !this.graveLabels.includes(l)); this.graveLabels = []; }
    this.graveGroup = null;
    if (!graves.length) return;
    const { minX, maxZ } = this.bounds;
    const g = new THREE.Group(); g.position.set(minX * PITCH, 0, maxZ * PITCH); this.scene.add(g); this.graveGroup = g;
    this.bx(8.4, 0.18, 8.4, this.dark ? '#7d7a70' : '#c9c3b4', 0, 0, 0, g);
    this.bx(7.6, 0.06, 7.6, this.dark ? '#3f5a3c' : '#7fa36b', 0, 0.18, 0, g);
    for (let i = -3.6; i <= 3.6; i += 0.6) {
      this.bx(0.08, 0.5, 0.08, '#e8e4dc', i, 0.24, 3.75, g); this.bx(0.08, 0.5, 0.08, '#e8e4dc', 3.75, 0.24, i, g);
      this.bx(0.08, 0.5, 0.08, '#e8e4dc', i, 0.24, -3.75, g); this.bx(0.08, 0.5, 0.08, '#e8e4dc', -3.75, 0.24, i, g);
    }
    for (const z of [-3.75, 3.75]) this.bx(7.6, 0.06, 0.06, '#e8e4dc', 0, 0.6, z, g);
    for (const x of [-3.75, 3.75]) this.bx(0.06, 0.06, 7.6, '#e8e4dc', x, 0.6, 0, g);
    this.tree(-2.9, -2.9, g, 0.8);
    const sign = new THREE.Object3D(); sign.position.set(0, 2.2, 3.4); g.add(sign);
    this.label(this.graveLabels, this.div('grave-sign', 'Graveyard'), sign, 0, 'fx', '__grave');
    graves.slice(0, 12).forEach((e, i) => {
      const x = -2.4 + (i % 4) * 1.6, z = -2 + Math.floor(i / 4) * 1.8;
      const st = new THREE.Group(); st.position.set(x, 0.24, z); st.userData.sid = e.sessionId; g.add(st);
      this.bx(0.8, 0.7, 0.22, '#b8bec7', 0, 0, 0, st);
      const top = this.mesh(new THREE.CylinderGeometry(0.4, 0.4, 0.22, 14, 1, false, 0, Math.PI), '#b8bec7', 0, 0.7, 0, st); top.rotation.set(Math.PI / 2, 0, Math.PI / 2);
      this.bx(0.9, 0.06, 0.5, '#6f8f5f', 0, 0, 0.25, st);
      const a = new THREE.Object3D(); a.position.y = 1.4; st.add(a);
      this.label(this.graveLabels, this.div('rip hidden-until-zoom', `<b>RIP ${esc(e.agent.name)}</b><span>${esc(e.epitaph)}</span>`), a, 0, 'fx', '__grave');
    });
  }

  /** PNG of the current frame (used for the README skyline). */
  snapshot(): string { this.renderer.render(this.scene, this.cam); return this.renderer.domElement.toDataURL('image/png'); }
  get canvas() { return this.renderer.domElement; }

  private confetti(p: ProjectView) {
    const b = this.buildings.get(p.id);
    if (!b) return;
    const g = new THREE.Group(); b.top.getWorldPosition(g.position); this.scene.add(g);
    const colors = ['#ff7a45', '#3f8efc', '#ffd84d', '#2f9e66', '#f472b6', '#9b6bff'];
    const parts = Array.from({ length: 70 }, (_, i) => {
      const m = new THREE.Mesh(new THREE.PlaneGeometry(0.16, 0.1), new THREE.MeshBasicMaterial({ color: colors[i % colors.length], side: THREE.DoubleSide }));
      g.add(m);
      return { m, v: new THREE.Vector3((Math.random() - 0.5) * 6, 4 + Math.random() * 5, (Math.random() - 0.5) * 6), r: new THREE.Vector3(Math.random() * 8, Math.random() * 8, 0) };
    });
    let life = 0;
    const up: Updater = (_t, dt) => {
      life += dt;
      for (const q of parts) { q.v.y -= 9 * dt; q.m.position.addScaledVector(q.v, dt); q.m.rotation.x += q.r.x * dt; q.m.rotation.y += q.r.y * dt; }
      if (life > 3.5) { this.freeObject(g); this.globalUpdaters = this.globalUpdaters.filter((f) => f !== up); }
    };
    this.globalUpdaters.push(up);
    const banner = this.div('shipped', `Shipped! ${esc(p.name)}`);
    const anchor = new THREE.Object3D(); b.top.add(anchor);
    const l = this.label(b.labels, banner, anchor, 1.2, 'fx', p.id);
    setTimeout(() => { l.remove(); }, 4000);
  }

  // ---------- frame ----------
  private loop = () => {
    this.raf = requestAnimationFrame(this.loop);
    const dt = Math.min(0.05, this.clock.getDelta());
    const t = this.reduce ? 0 : this.clock.elapsedTime;
    this.elapsed = this.clock.elapsedTime;
    for (const f of this.globalUpdaters) f(t, dt);
    for (const b of this.buildings.values()) for (const f of b.updaters) f(t, dt);
    this.renderer.render(this.scene, this.cam);
    const el = this.renderer.domElement, W = el.clientWidth, H = el.clientHeight;
    const zoomedIn = this.zoom > 1.4;
    const raised: { L: Label; x: number; y: number }[] = [];
    for (const L of this.labels) {
      const st = L.el.dataset.state;
      let show = true;
      if (L.kind === 'tag') show = L.pid === this.selected || (zoomedIn && L.pid === this.hovered);
      if (L.kind === 'chat') { const seed = Number(L.el.dataset.seed ?? 0); show = L.pid === this.selected || (this.zoom > 1.05 && Math.floor((this.elapsed + seed) / 6) % 3 === 0); }
      if (L.kind === 'bb') {
        const important = st === 'site' || st === 'needs' || L.pid === this.selected || L.pid === this.hovered;
        L.el.classList.toggle('mini', !important && !zoomedIn);
        L.el.classList.toggle('sel', L.pid === this.selected);
        show = st !== 'lot' || important || zoomedIn;
      }
      if (L.el.classList.contains('hidden-until-zoom')) show = zoomedIn || L.pid === this.hovered || L.pid === this.selected;
      if (!show) { L.el.style.display = 'none'; continue; }
      L.obj.getWorldPosition(this.v); this.v.y += L.dy; this.v.project(this.cam);
      if (this.v.x < -1.2 || this.v.x > 1.2 || this.v.y < -1.2 || this.v.y > 1.2) { L.el.style.display = 'none'; continue; }
      L.el.style.display = '';
      const x = ((this.v.x + 1) / 2) * W, y = ((1 - this.v.y) / 2) * H;
      if (L.kind === 'bb' && (st === 'site' || st === 'needs')) { raised.push({ L, x, y }); continue; }
      L.el.style.transform = `translate(${x.toFixed(1)}px,${y.toFixed(1)}px) translate(-50%,-100%)`;
      L.el.style.zIndex = String(Math.round(1000 - this.v.z * 500) + (L.kind === 'bb' ? 0 : 2000));
    }
    // Active projects: lift their name tags above the skyline on a dotted leader, and nudge them apart so none overlap.
    raised.sort((a, b) => b.y - a.y);
    const placed: { x: number; y: number; w: number; h: number }[] = [];
    for (const r of raised) {
      const w = r.L.el.offsetWidth, h = r.L.el.offsetHeight + 8;
      let y = r.y - 96;
      for (let guard = 0, moved = true; moved && guard < 24; guard++) {
        moved = false;
        for (const q of placed) {
          if (Math.abs(r.x - q.x) < (w + q.w) / 2 + 8 && y > q.y - q.h && y - h < q.y) { y = q.y - q.h - 6; moved = true; }
        }
      }
      placed.push({ x: r.x, y, w, h });
      r.L.el.style.transform = `translate(${r.x.toFixed(1)}px,${y.toFixed(1)}px) translate(-50%,-100%)`;
      r.L.el.style.zIndex = String(5000 + Math.round(y));
      const leader = r.L.el.querySelector('.leader') as HTMLElement | null;
      if (leader) leader.style.height = `${Math.max(0, r.y - y - 6).toFixed(1)}px`;
    }
  };
}
