import * as THREE from 'three';
import type { GraveEntry, ProjectView, RoutineView, SessionView, StateView } from '../../../daemon/types.ts';
import { buildCrew, setCrewNight, type CrewMode } from './crew3d.ts';
import type { Mood } from '../crew/Avatar.tsx';
import { compact, nextRunText } from '../format.ts';
import { shortDoing, shortJob, type Bubble } from '../copy.ts';

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
type Label = { el: HTMLElement; obj: THREE.Object3D; dy: number; kind: 'bb' | 'tag' | 'fx' | 'chat' | 'hello' | 'district'; pid: string };
type Slot = { pos: [number, number, number]; face: number; walk?: [[number, number, number], [number, number, number]] };

/** Nearest isometric corner view: π/4 + k·π/2. */
const PAN_KEYS: Record<string, 'left' | 'right' | 'up' | 'down'> = { ArrowLeft: 'left', ArrowRight: 'right', ArrowUp: 'up', ArrowDown: 'down', a: 'left', d: 'right', w: 'up', s: 'down' };
function snapCorner(az: number) { return Math.PI / 4 + Math.round((az - Math.PI / 4) / (Math.PI / 2)) * (Math.PI / 2); }
function hash(s: string) { let h = 2166136261; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return h >>> 0; }
function rand(seed: number) { return () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; }; }
/** On a coffee break: done for now, waiting on you, not long enough to count as away. They spend it at the café. */
export const onBreak = (s: SessionView) => s.status === 'idle' && !s.away;
/** Chat bubbles are a glance, not a log: paths become just the file name and long lines are cut. */
const chatText = (s: string) => { const t = s.replace(/\S*\/(\S+)/g, '$1').replace(/\s+/g, ' ').trim(); return t.length > 64 ? t.slice(0, 62).trimEnd() + '…' : t; };
const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!));

/**
 * A scheduled job between runs, drawn as a crew member asleep beside its building.
 * It carries its last run's id, so clicking it opens that run.
 */
function sleeperView(r: RoutineView): SessionView {
  return {
    id: r.lastSessionId, projectId: r.projectId, agent: r.agent, title: r.title, focus: null, status: 'ended', away: true, scheduled: true,
    action: null, actionKind: null, needsMessage: null, branch: null, worktree: null, cwd: null, kind: null,
    startedAt: r.lastRunAt, lastEventAt: r.lastEndedAt, endedAt: r.lastEndedAt, endReason: null,
    tokens: 0, bricks: 0, tokensBreakdown: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, subagents: 0 }, model: null, costUsd: 0, costEstimated: true,
    linesAdded: null, linesRemoved: null, size: null, commits: 0, prUrl: null, prState: null, stamp: r.lastStamp, outcome: r.lastOutcome,
    lastPrompt: null, firstPrompt: r.prompt, prompts: 0, helperActive: false, stuck: null, collision: null, lastCheck: null, chatter: null, filesChanged: 0,
  };
}

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

export type CityOptions = { onSelect: (id: string | null) => void; onAgent?: (sessionId: string) => void; onHover?: (id: string | null) => void; onGraveyard?: () => void };

export class CityScene {
  private renderer: THREE.WebGLRenderer;
  private scene = new THREE.Scene();
  private cam = new THREE.OrthographicCamera(-1, 1, 1, -1, -400, 800);
  private target = new THREE.Vector3(0, 2, 0);
  private OFF = new THREE.Vector3(30, 26, 30);
  private az = Math.PI / 4; // camera bearing around the town; π/4 is the classic isometric corner
  private anim: { t0: number; dur: number; from: { x: number; z: number; az: number; zoom: number }; to: { x: number; z: number; az: number; zoom: number } } | null = null;
  private zoom = 1;
  /** Pan directions whose keys are held down (arrows / WASD). */
  private held = new Set<'left' | 'right' | 'up' | 'down'>();
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
  private doingEls = new Map<string, HTMLElement>();
  /** What each agent's always-on bubble says: the job they're on, the project, or their current step in 2–3 words. */
  private bubble: Bubble = 'job';
  private projectNames = new Map<string, string>();
  // New agents walk in from the street and say hi: when each session was first seen arriving (ms), and every session seen so far.
  private arrivals = new Map<string, number>();
  private seenSids = new Set<string>();
  /** Sleeping scheduled jobs on the map, by the session id their figure carries. */
  private sleepers = new Map<string, RoutineView>();
  private routineSeen = new Map<string, 'awake' | 'asleep'>();
  /** A scheduled job that just woke up (live session id) or just dozed off (sleeper id) -> when. */
  private waking = new Map<string, number>();
  private dozing = new Map<string, number>();
  private modeOf(s: SessionView): Mode { return this.sleepers.has(s.id) ? 'sleep' : modeFor(s); }
  private states = 0;
  private hl: { sessions: Set<string> | null; projects: Set<string> | null } = { sessions: null, projects: null };
  private graveGroup: THREE.Group | null = null;
  private parkGroup: THREE.Group | null = null;
  private parkLabels: Label[] = [];
  private parkKey = '';
  private crewFigures: { g: THREE.Object3D; base: number; h: number; pid: string }[] = [];
  private crewRings: THREE.Object3D[] = [];
  private last: { data: StateView; showLots: boolean } | null = null;
  private graveLabels: Label[] = [];
  private graveKey = '';
  private elapsed = 0;
  private cafe: { group: THREE.Group; updaters: Updater[]; labels: Label[]; key: string } | null = null;
  private cafeHover = false;

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
    const changed = dark !== this.dark;
    this.dark = dark;
    this.scene.background = new THREE.Color(dark ? '#1b2636' : '#d4ebf2');
    // three.js r155+ uses physical light units: these are the prototype's values × π.
    this.hemi.intensity = dark ? 1.0 : 2.0;
    this.hemi.color.set(dark ? '#8fa3e6' : '#ffffff');
    this.hemi.groundColor.set(dark ? '#3a4a3a' : '#9cc483');
    this.sun.intensity = dark ? 0.9 : 2.6;
    this.sun.color.set(dark ? '#b9c6ff' : '#fff1dc');
    for (const c of this.crewFigures) setCrewNight(c.g, dark);
    // glows and site lights are tuned per theme: rebuild what's on screen
    if (changed && this.last) { for (const b of this.buildings.values()) b.key = ''; this.setState(this.last.data, this.last.showLots); }
    for (const m of this.winMats) { m.emissive.set(dark ? '#ffc861' : '#000000'); m.emissiveIntensity = dark ? 0.55 : 0; }
  }

  /** Highlight a subset: only these agents are shown, and only these projects keep their name tags. null = everything. */
  setFocus(sessions: Set<string> | null, projects: Set<string> | null, sessionProjects: Set<string> = new Set()) { this.hl = { sessions, projects }; this.focusPids = sessionProjects; }
  private focusPids = new Set<string>();

  setSelected(id: string | null) {
    const changed = id !== this.selected;
    this.selected = id;
    if (id && changed) this.focus(id);
  }

  /** Turns the camera around the town by `deg` (positive = clockwise as seen from above). */
  rotateBy(deg: number) {
    const base = this.anim ? this.anim.to : { x: this.target.x, z: this.target.z, az: this.az, zoom: this.zoom };
    this.flyTo({ ...base, az: snapCorner(base.az + (deg * Math.PI) / 180) });
  }
  /** Back to the classic north-up corner view. */
  resetView() { this.flyTo({ x: this.target.x, z: this.target.z, az: Math.round((this.az - Math.PI / 4) / (2 * Math.PI)) * 2 * Math.PI + Math.PI / 4, zoom: this.zoom }); }

  private flyTo(to: { x: number; z: number; az: number; zoom: number }, dur = 650) {
    if (this.reduce) { this.target.x = to.x; this.target.z = to.z; this.az = to.az; this.zoom = to.zoom; this.anim = null; this.placeCam(); this.resize(); return; }
    this.anim = { t0: performance.now(), dur, from: { x: this.target.x, z: this.target.z, az: this.az, zoom: this.zoom }, to };
  }
  private stepAnim() {
    if (!this.anim) return;
    const { t0, dur, from, to } = this.anim;
    const u = Math.min(1, (performance.now() - t0) / dur), e = u < 0.5 ? 4 * u * u * u : 1 - (-2 * u + 2) ** 3 / 2;
    this.target.x = from.x + (to.x - from.x) * e; this.target.z = from.z + (to.z - from.z) * e;
    this.az = from.az + (to.az - from.az) * e; this.zoom = from.zoom + (to.zoom - from.zoom) * e;
    if (u >= 1) this.anim = null;
    this.placeCam(); this.resize();
  }
  /** Horizontal unit vectors for the current bearing: screen-right and into-the-screen. */
  private axes() {
    const right = new THREE.Vector3(Math.cos(this.az), 0, -Math.sin(this.az));
    const fwd = new THREE.Vector3(-Math.sin(this.az), 0, -Math.cos(this.az));
    return { right, fwd };
  }

  setState(data: StateView, showLots: boolean) {
    this.last = { data, showLots };
    this.projectNames = new Map(data.projects.map((p) => [p.id, p.name]));
    const firstLook = this.states++ === 0; // everyone already here on page load just stands in place
    for (const s of data.sessions) if (!this.seenSids.has(s.id)) {
      this.seenSids.add(s.id);
      if (!firstLook && s.status !== 'ended' && s.startedAt && Date.now() - s.startedAt < 120_000) this.arrivals.set(s.id, Date.now());
    }
    // scheduled jobs: asleep beside their building between runs; a run starting wakes them, a run ending puts them back to bed
    this.sleepers.clear();
    for (const r of data.routines ?? []) {
      const was = this.routineSeen.get(r.key);
      if (!firstLook && was === 'asleep' && r.state === 'awake' && r.liveSessionId) { this.waking.set(r.liveSessionId, Date.now()); this.arrivals.delete(r.liveSessionId); }
      if (!firstLook && was === 'awake' && r.state === 'asleep') this.dozing.set(r.lastSessionId, Date.now());
      this.routineSeen.set(r.key, r.state);
      if (r.state === 'asleep') this.sleepers.set(r.lastSessionId, r);
    }
    const visible = data.projects.filter((p) => showLots || p.state !== 'lot');
    const byProject = new Map<string, SessionView[]>();
    const breaks = new Map<string, number>();
    const cafeCrew: SessionView[] = [];
    for (const s of data.sessions) if (s.status !== 'ended' && s.projectId) {
      // agents on a coffee break leave their building for the café
      if (onBreak(s)) { cafeCrew.push(s); breaks.set(s.projectId, (breaks.get(s.projectId) ?? 0) + 1); continue; }
      if (!byProject.has(s.projectId)) byProject.set(s.projectId, []);
      byProject.get(s.projectId)!.push(s);
    }
    for (const r of this.sleepers.values()) {
      if (!byProject.has(r.projectId)) byProject.set(r.projectId, []);
      byProject.get(r.projectId)!.push(sleeperView(r));
    }
    // ground
    const xs = visible.map((p) => p.lot[0]), zs = visible.map((p) => p.lot[1]);
    const b = xs.length ? { minX: Math.min(...xs), maxX: Math.max(...xs), minZ: Math.min(...zs), maxZ: Math.max(...zs) } : { minX: 0, maxX: 0, minZ: 0, maxZ: 0 };
    // An extra column at the edge of town: the café at its far end, the graveyard at its near end.
    b.minX -= 1;
    if (data.graveyard?.length && b.minZ === b.maxZ) b.minZ -= 1;
    const gk = JSON.stringify(b) + this.dark;
    if (gk !== this.groundKey) { this.groundKey = gk; this.bounds = b; this.buildGround(); this.graveKey = ''; }
    const pk = JSON.stringify([data.districts ?? [], visible.map((p) => p.lot), !!data.graveyard?.length]) + this.groundKey;
    if (pk !== this.parkKey) { this.parkKey = pk; this.buildParks(data.districts ?? [], visible, !!data.graveyard?.length); }
    const grk = JSON.stringify((data.graveyard ?? []).map((e) => e.sessionId)) + this.groundKey;
    if (grk !== this.graveKey) { this.graveKey = grk; this.buildGraveyard(data.graveyard ?? []); }
    const visiblePids = new Set(visible.map((p) => p.id));
    const regulars = cafeCrew.filter((s) => visiblePids.has(s.projectId!)).sort((a, c) => a.id.localeCompare(c.id));
    const ck = JSON.stringify(regulars.map((s) => [s.id, s.agent.title, s.helperActive, !!s.chatter])) + this.groundKey;
    if (!this.cafe || this.cafe.key !== ck) this.buildCafe(regulars, ck);
    // buildings
    const seen = new Set<string>();
    for (const p of visible) {
      seen.add(p.id);
      const sessions = (byProject.get(p.id) ?? []).sort((a, c) => a.id.localeCompare(c.id));
      const away = breaks.get(p.id) ?? 0;
      const key = JSON.stringify([p.state, p.floors, Math.round((p.size ?? 0) * 20), p.lot, p.name, p.prState, p.justShipped, p.stuck, p.checksFailing, p.justMerged, p.bricks, away, sessions.map((s) => [s.id, this.modeOf(s), s.helperActive, s.agent.title, !!s.stuck, !!s.chatter, s.away, this.sleepers.has(s.id) ? nextRunText(this.sleepers.get(s.id)!.nextAt) : null])]);
      const prev = this.buildings.get(p.id);
      if (prev && prev.key === key) continue;
      const celebrate = !!prev && (prev.state === 'site' || prev.state === 'needs') && !(p.state === 'site' || p.state === 'needs');
      // a rebuild keeps the lot at the height it already reached, so a raised site doesn't drop and rise again (and jolt its labels) on every update
      const startY = prev?.group.position.y ?? 0;
      if (prev) this.removeBuilding(p.id);
      this.addBuilding(p, sessions, key, away, startY);
      if (celebrate) this.confetti(p);
    }
    for (const id of [...this.buildings.keys()]) if (!seen.has(id)) this.removeBuilding(id);
    for (const s of data.sessions) {
      const el = this.chatEls.get(s.id); if (el && s.chatter && el.textContent !== chatText(s.chatter)) el.textContent = chatText(s.chatter);
    }
    this.refreshBubbles(data);
    if (!this.fitted && visible.length) { this.fitted = true; this.fit(); }
  }

  setBubble(mode: Bubble) {
    if (mode === this.bubble) return;
    this.bubble = mode;
    if (this.last) this.refreshBubbles(this.last.data);
  }

  private bubbleText(s: SessionView) {
    if (this.bubble === 'task') return shortDoing(s);
    const project = this.projectNames.get(s.projectId ?? '');
    if (this.bubble === 'project') return project ?? shortDoing(s);
    return shortJob(s.focus) ?? shortJob(s.title) ?? project ?? shortDoing(s);
  }

  private refreshBubbles(data: StateView) {
    for (const s of data.sessions) {
      const d = this.doingEls.get(s.id)?.querySelector('.doing'); const txt = this.bubbleText(s); if (d && d.textContent !== txt) d.textContent = txt;
    }
  }

  fit() {
    const { minX, maxX, minZ, maxZ } = this.bounds;
    this.target.set(((minX + maxX) / 2) * PITCH, 2, ((minZ + maxZ) / 2) * PITCH);
    this.anim = null;
    this.viewSize = 60; this.zoom = 1;
    this.placeCam(); this.resize();
    // Measure where the town's corners land on screen, then scale so it just fills the view.
    this.cam.updateMatrixWorld();
    let ex = 0, ey = 0;
    for (const x of [minX - 0.5, maxX + 0.5]) for (const z of [minZ - 0.5, maxZ + 0.5]) for (const y of [0, 6]) {
      this.v.set(x * PITCH, y, z * PITCH).project(this.cam);
      ex = Math.max(ex, Math.abs(this.v.x)); ey = Math.max(ey, Math.abs(this.v.y));
    }
    this.viewSize = Math.max(30, this.viewSize * Math.max(ex / 0.96, ey / 0.86));
    this.resize();
  }

  zoomBy(f: number) {
    if (this.anim) { this.anim.to.zoom = Math.max(0.35, Math.min(4, this.anim.to.zoom * f)); return; }
    this.zoom = Math.max(0.35, Math.min(4, this.zoom * f)); this.resize();
  }

  /** Slide the view: `right`/`fwd` are in screen-heights (positive = right / up the screen). */
  panBy(right: number, fwd: number) {
    const vh = this.cam.top - this.cam.bottom;
    this.panWorld(right * vh, -fwd * vh);
  }
  /** dx, dy in world units along screen-right and screen-down; kept inside the town's edges. */
  private panWorld(dx: number, dy: number) {
    const { right, fwd } = this.axes();
    // the view looks down at ~31°, so screen-vertical moves cover more ground
    const mx = right.x * dx - fwd.x * dy * 1.9, mz = right.z * dx - fwd.z * dy * 1.9;
    const { minX, maxX, minZ, maxZ } = this.bounds;
    const clampX = (x: number) => Math.max((minX - 1) * PITCH, Math.min((maxX + 1) * PITCH, x));
    const clampZ = (z: number) => Math.max((minZ - 1) * PITCH, Math.min((maxZ + 1) * PITCH, z));
    // mid-flight, shift where the flight lands too, so the two don't fight
    if (this.anim) { this.anim.to.x = clampX(this.anim.to.x + mx); this.anim.to.z = clampZ(this.anim.to.z + mz); }
    this.target.x = clampX(this.target.x + mx); this.target.z = clampZ(this.target.z + mz);
    this.placeCam();
  }

  /** Projects with crew on site right now (working, or waiting on you). */
  activeProjects(): string[] {
    return (this.last?.data.projects ?? []).filter((p) => (p.state === 'site' || p.state === 'needs') && this.buildings.has(p.id)).map((p) => p.id);
  }

  /** Fly in close enough that every active project fills the view. Returns false when nobody is working. */
  focusActive(): boolean {
    const ids = this.activeProjects();
    if (!ids.length) return false;
    const box = new THREE.Box3();
    for (const id of ids) box.expandByObject(this.buildings.get(id)!.group);
    box.min.y = 0; box.max.y = Math.max(box.max.y, 4) + 2; // room for the name tags above the roofs
    const cx = (box.min.x + box.max.x) / 2, cz = (box.min.z + box.max.z) / 2;
    // Measure the box in screen axes for the bearing we'll end on.
    const az = this.anim ? this.anim.to.az : this.az;
    const right = new THREE.Vector3(Math.cos(az), 0, -Math.sin(az));
    const back = new THREE.Vector3(Math.sin(az) * 42.43, 26, Math.cos(az) * 42.43).normalize();
    const up = new THREE.Vector3().crossVectors(back, right);
    let hw = 0, hh = 0;
    for (const x of [box.min.x, box.max.x]) for (const y of [box.min.y, box.max.y]) for (const z of [box.min.z, box.max.z]) {
      this.v.set(x - cx, y - 2, z - cz);
      hw = Math.max(hw, Math.abs(this.v.dot(right))); hh = Math.max(hh, Math.abs(this.v.dot(up)));
    }
    const W = this.container.clientWidth || 1, H = this.container.clientHeight || 1, a = W / H;
    const base = Math.max(this.viewSize / Math.max(a, 1) * 0.9, this.viewSize / a * 0.9, 24);
    const vh = Math.max((2 * hh) / 0.8, (2 * hw) / (0.85 * a), 10);
    this.flyTo({ x: cx, z: cz, az, zoom: Math.max(0.35, Math.min(2.4, base / vh)) });
    return true;
  }

  /** side: where the UI covers the view (a panel on the right by default; the welcome cards sit on the left). */
  focus(id: string, side: 'right' | 'left' = 'right') {
    const b = this.buildings.get(id);
    if (!b) return;
    this.flyToObject(b.group, side);
  }
  /** Fly over to the café. */
  focusCafe() { if (this.cafe) this.flyToObject(this.cafe.group, false); }

  private flyToObject(o: THREE.Object3D, besidePanel: boolean | 'right' | 'left' = true) {
    o.getWorldPosition(this.v);
    const zoom = Math.max(this.zoom, 1.8);
    // Center the building in the part of the town the side panel doesn't cover.
    const W = this.container.clientWidth || 1, H = this.container.clientHeight || 1, a = W / H;
    const panel = besidePanel && W > 720 ? Math.min(380, W - 24) + 12 : 0;
    const vh = Math.max(this.viewSize / Math.max(a, 1) * 0.9, this.viewSize / a * 0.9, 24) / zoom;
    const shift = (panel / 2) * (vh / H) * (besidePanel === 'left' ? -1.15 : 1);
    const { right, fwd } = this.axes();
    void fwd;
    this.flyTo({ x: this.v.x + right.x * shift, z: this.v.z + right.z * shift, az: this.az, zoom });
  }

  dispose() {
    cancelAnimationFrame(this.raf);
    this.disposeFns.forEach((f) => f());
    for (const id of [...this.buildings.keys()]) this.removeBuilding(id);
    if (this.cafe) { this.freeObject(this.cafe.group); this.dropLabels(this.cafe.labels); this.cafe = null; }
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
    this.OFF.set(Math.sin(this.az) * 42.43, 26, Math.cos(this.az) * 42.43);
    this.cam.position.copy(this.target).add(this.OFF);
    this.cam.lookAt(this.target);
    // keep the shadow camera centered on what we look at
    const span = Math.max(40, this.viewSize / this.zoom * 0.9);
    Object.assign(this.sun.shadow.camera, { left: -span, right: span, top: span, bottom: -span, near: 1, far: 160 });
    this.sun.shadow.camera.updateProjectionMatrix();
    this.sun.position.set(this.target.x + 18, 40, this.target.z + 10);
    this.sun.target.position.copy(this.target);
  }

  private pickAny(clientX: number, clientY: number): { kind: 'project' | 'agent' | 'grave' | 'cafe'; id: string; cafe?: boolean } | null {
    const r = this.renderer.domElement.getBoundingClientRect();
    this.ndc.set(((clientX - r.left) / r.width) * 2 - 1, -((clientY - r.top) / r.height) * 2 + 1);
    this.ray.setFromCamera(this.ndc, this.cam);
    const roots = [...this.buildings.values()].map((b) => b.group as THREE.Object3D);
    if (this.graveGroup) roots.push(this.graveGroup);
    if (this.cafe) roots.push(this.cafe.group);
    const hit = this.ray.intersectObjects(roots, true)[0];
    let o: THREE.Object3D | null = hit?.object ?? null;
    let inCafe = false;
    for (let q: THREE.Object3D | null = o; q; q = q.parent) if (q.userData.cafe) inCafe = true;
    while (o && !o.userData.pid && !o.userData.sid && !o.userData.grave && !o.userData.cafe) o = o.parent;
    if (o?.userData.sid) return { kind: 'agent', id: o.userData.sid, cafe: inCafe };
    if (o?.userData.cafe) return { kind: 'cafe', id: '__cafe', cafe: true };
    if (o?.userData.pid) return { kind: 'project', id: o.userData.pid };
    if (o?.userData.grave) return { kind: 'grave', id: '__grave' };
    return null;
  }
  private pick(clientX: number, clientY: number): string | null {
    const h = this.pickAny(clientX, clientY);
    return h?.kind === 'project' ? h.id : null;
  }

  private bindInput() {
    const el = this.renderer.domElement;
    el.style.touchAction = 'none';
    let drag: { x: number; y: number; sx: number; sy: number; rotate: boolean } | null = null;
    el.addEventListener('contextmenu', (e) => e.preventDefault());
    const pointers = new Map<number, { x: number; y: number }>();
    let pinch = 0;
    const down = (e: PointerEvent) => {
      pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (pointers.size === 2) { const [a, b] = [...pointers.values()]; pinch = Math.hypot(a.x - b.x, a.y - b.y); drag = null; return; }
      this.anim = null;
      drag = { x: e.clientX, y: e.clientY, sx: e.clientX, sy: e.clientY, rotate: e.button === 2 || e.shiftKey || e.altKey };
      el.style.cursor = drag.rotate ? 'ew-resize' : 'grabbing';
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
        const h = this.pickAny(e.clientX, e.clientY);
        const id = h?.kind === 'project' ? h.id : null;
        el.style.cursor = h ? 'pointer' : 'grab';
        this.cafeHover = !!h?.cafe;
        if (id !== this.hovered) { this.hovered = id; this.opts.onHover?.(id); }
        return;
      }
      if (drag.rotate) {
        this.az -= ((e.clientX - drag.x) / (el.clientWidth || 1)) * Math.PI * 2;
        drag.x = e.clientX; drag.y = e.clientY;
        this.placeCam();
        return;
      }
      const upp = (this.cam.top - this.cam.bottom) / (el.clientHeight || 1);
      // dragging moves the ground with the pointer, so the view slides the other way
      this.panWorld(-(e.clientX - drag.x) * upp, -(e.clientY - drag.y) * upp);
      drag.x = e.clientX; drag.y = e.clientY;
    };
    const up = (e: PointerEvent) => {
      pointers.delete(e.pointerId);
      if (pointers.size < 2) pinch = 0;
      if (drag && Math.hypot(e.clientX - drag.sx, e.clientY - drag.sy) < 5) {
        const h = this.pickAny(e.clientX, e.clientY);
        if (h?.kind === 'agent' && this.opts.onAgent) this.opts.onAgent(h.id);
        else if (h?.kind === 'grave' && this.opts.onGraveyard) this.opts.onGraveyard();
        else if (h?.kind === 'cafe') this.focusCafe();
        else this.opts.onSelect(h?.kind === 'project' ? h.id : null);
      }
      // Settle on the nearest of the four isometric corners: in-between angles shear the grid and look off.
      if (drag?.rotate) this.flyTo({ x: this.target.x, z: this.target.z, az: snapCorner(this.az), zoom: this.zoom }, 350);
      drag = null;
      el.style.cursor = this.hovered ? 'pointer' : 'grab';
    };
    const key = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement)?.closest?.('input, textarea, select, [contenteditable], [role="dialog"]') || e.metaKey || e.ctrlKey || e.altKey) return;
      if (!this.container.isConnected || !this.container.offsetParent) return;
      const pan = PAN_KEYS[e.key.length === 1 ? e.key.toLowerCase() : e.key];
      if (pan) { this.held.add(pan); e.preventDefault(); return; }
      if (e.repeat && !'+=-_'.includes(e.key)) return;
      switch (e.key) {
        case 'q': case 'Q': this.rotateBy(-90); break;
        case 'e': case 'E': this.rotateBy(90); break;
        case '+': case '=': this.zoomBy(1.25); break;
        case '-': case '_': this.zoomBy(0.8); break;
        case 'f': case 'F': case '0': this.fit(); break;
        case 'g': case 'G': this.focusActive(); break;
        default: return;
      }
      e.preventDefault();
    };
    const keyUp = (e: KeyboardEvent) => { const pan = PAN_KEYS[e.key.length === 1 ? e.key.toLowerCase() : e.key]; if (pan) this.held.delete(pan); };
    const blur = () => this.held.clear();
    addEventListener('keydown', key);
    addEventListener('keyup', keyUp);
    addEventListener('blur', blur);
    this.disposeFns.push(() => { removeEventListener('keydown', key); removeEventListener('keyup', keyUp); removeEventListener('blur', blur); });
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
    this.dropLabels(b.labels);
    this.buildings.delete(id);
  }

  private dropLabels(list: Label[]) {
    for (const l of list) { l.el.remove(); if (l.kind === 'chat') for (const [k, v] of this.chatEls) if (v === l.el) this.chatEls.delete(k); if (l.el.dataset.sid && this.doingEls.get(l.el.dataset.sid) === l.el) this.doingEls.delete(l.el.dataset.sid); }
    this.labels = this.labels.filter((l) => !list.includes(l));
  }

  private addBuilding(p: ProjectView, sessions: SessionView[], key: string, onBreakCount = 0, startY = 0) {
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
    if (live) this.raise(outer, p.state === 'needs' ? '#e5484d' : '#17c3c3', updaters, startY);
    let color = PALETTE[h % PALETTE.length];
    if (quiet) color = this.desat(color);
    const recent = p.state === 'recent';
    // Footprint grows with scope (as does height), with a slight per-project lean so blocks aren't all square.
    // Capped so the biggest block plus its scaffold and crew ring still sit on the lot.
    const side = 2.6 + 3.2 * Math.max(0, Math.min(1, p.size ?? 0.4));
    const lean = (((h >> 4) % 5) - 2) * 0.04;
    const w = side * (1 + lean), d = side * (1 - lean);
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

    // builders: on a ring that turns with the camera, so the crew is always on the side of the building facing you
    const ring = new THREE.Group(); ring.userData.crewRing = true; ring.rotation.y = this.az - Math.PI / 4; g.add(ring); this.crewRings.push(ring);
    const slots = this.slots(w, d, roofY, building && floors > 1 ? Math.min(3, Math.max(1, floors - 1)) : 0);
    const used = new Set<number>();
    sessions.forEach((s, i) => {
      const mode = this.modeOf(s);
      const pref: Record<Mode, number[]> = { hammer: [0, 4, 6], walk: [1, 7, 5], read: [2, 6, 5], carry: [3, 7, 5], wave: [5, 8, 6], sit: [8, 9, 5, 6], stuck: [0, 4, 6], stand: [8, 9, 5], sleep: [9, 8, 7, 3] };
      let idx = pref[mode].find((k) => !used.has(k) && slots[k]);
      if (idx === undefined) idx = slots.findIndex((sl, k) => sl && !used.has(k));
      if (idx === -1 || idx === undefined) idx = 9 + i;
      used.add(idx);
      const slot = slots[idx] ?? { pos: [(i % 3) - 1, 0, d / 2 + 2.2] as [number, number, number], face: Math.PI / 4 };
      this.builder(ring, p.id, s, mode, slot, updaters, labels);
    });

    // weather and events
    if (p.stuck) this.rainCloud(g, (live || building ? roofY + 4.2 : roofY + 3), updaters);
    if (p.checksFailing && !isLot) this.fire(g, roofY, w, d, updaters);
    if (p.justMerged && !isLot) this.fireworks(g, roofY + 2, updaters);

    // billboard
    const pr = p.prState === 'merged' ? '<span class="pr merged">merged</span>' : p.prState === 'open' ? '<span class="pr open">PR open</span>' : '';
    const asleep = sessions.filter((s) => this.sleepers.has(s.id)).length, awake = sessions.length - asleep;
    const crewText = p.state === 'needs' ? 'hand raised'
      : !awake && onBreakCount ? 'all at the café'
      : `${awake + onBreakCount} on site${onBreakCount ? ` · ${onBreakCount} at the café` : ''}${asleep ? ` · ${asleep} asleep` : ''}`;
    const crew = live ? `<span class="crew">${crewText}</span>` : '';
    const bb = this.div('bb', `<span class="d" style="background:${STATE_DOT[p.state]}"></span><b>${esc(p.name)}</b>${crew}${p.bricks ? `<span class="tok">${compact(p.bricks)} bricks</span>` : ''}${pr}`);
    bb.dataset.state = p.state;
    if (live) { const leader = document.createElement('i'); leader.className = 'leader'; bb.appendChild(leader); }
    bb.onclick = () => this.opts.onSelect(p.id);
    bb.onpointerenter = () => { this.hovered = p.id; };
    this.label(labels, bb, top, 0, 'bb', p.id);

    this.buildings.set(p.id, { group: outer, key, updaters, labels, top, state: p.state });
  }

  /** Lifts a lot with crew on site onto a lit plinth, with a pulsing ring on the street below. */
  private raise(outer: THREE.Group, accent: string, updaters: Updater[], startY = 0) {
    const plinth = this.bx(8.4, 1, 8.4, this.tint(accent, 0.55), 0, 0, 0, outer);
    const rimMat = new THREE.MeshBasicMaterial({ color: accent, transparent: true });
    const rim = new THREE.Group(); outer.add(rim);
    for (const [w, d, x, z] of [[8.6, 0.12, 0, 4.24], [8.6, 0.12, 0, -4.24], [0.12, 8.6, 4.24, 0], [0.12, 8.6, -4.24, 0]] as const) {
      const bar = new THREE.Mesh(new THREE.BoxGeometry(w, 0.14, d), rimMat); bar.position.set(x, -0.05, z); rim.add(bar);
    }
    const ringMat = new THREE.MeshBasicMaterial({ color: accent, transparent: true, opacity: 0.5, side: THREE.DoubleSide, depthWrite: false });
    const ring = new THREE.Mesh(new THREE.RingGeometry(5.6, 6.2, 48), ringMat); ring.rotation.x = -Math.PI / 2; outer.add(ring);
    // A soft column of light over the site and a real light that warms the building and its crew.
    const beamMat = new THREE.MeshBasicMaterial({ color: accent, transparent: true, opacity: 0.12, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide });
    const beam = new THREE.Mesh(new THREE.CylinderGeometry(4.2, 4.6, 18, 32, 1, true), beamMat); beam.position.y = 9; beam.renderOrder = -1; outer.add(beam);
    const lamp = new THREE.PointLight(this.tint(accent, 0.45), this.dark ? 70 : 14, 16, 1.6); lamp.position.set(2.5, 6, 3.5); outer.add(lamp);
    outer.position.y = startY;
    updaters.push((t, dt) => {
      const b = 0.5 + 0.5 * Math.sin(t * 2);
      beamMat.opacity = (this.dark ? 0.14 : 0.08) + 0.06 * b;
      lamp.intensity = (this.dark ? 70 : 14) * (0.85 + 0.15 * b);
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
      // window bays spaced ~1.3 apart, so wide buildings get more windows rather than stretched ones
      const nd = Math.max(2, Math.round(d / 1.3)), nw = Math.max(2, Math.round(w / 1.3));
      for (let k = 0; k < nd; k++) this.bx(0.06, 0.46, 0.62, wm, w / 2 + 0.02, i * FH + 0.3, ((k + 0.5) / nd - 0.5) * d * 0.9, g);
      for (let k = 0; k < nw; k++) this.bx(0.62, 0.46, 0.06, wm, ((k + 0.5) / nw - 0.5) * w * 0.9, i * FH + 0.3, d / 2 + 0.02, g);
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
    const L1 = levels >= 1 ? FH : 0, L2 = levels >= 2 ? 2 * FH : L1;
    const sx = w / 2 + (levels ? 0.85 : 1.4), sz = d / 2 + (levels ? 0.85 : 1.4);
    const s: (Slot | null)[] = [
      { pos: [sx, L1, 0.6], face: -Math.PI / 2 },                                                  // 0 wall, +x face
      { pos: [0, L2, sz], face: 0, walk: [[-w / 2 + 0.6, L2, sz], [w / 2 - 0.6, L2, sz]] },          // 1 plank walk, +z face
      roofY > 0.5 ? { pos: [0.6, roofY, 0.4], face: 0.6 } : { pos: [-1.2, 0, d / 2 + 2], face: 0.6 }, // 2 roof / blueprint
      { pos: [w / 2 + 1.9, 0, 0], face: 0, walk: [[w / 2 + 1.9, 0, -d / 2], [w / 2 + 1.9, 0, d / 2 - 0.2]] }, // 3 ground carry
      { pos: [-0.9, L1, sz], face: Math.PI },                                                     // 4 wall, +z face
      { pos: [1.2, L1, sz], face: Math.PI / 4 },                                                  // 5 front, facing camera
      { pos: [sx, levels >= 3 ? 3 * FH : L1, -1.1], face: -Math.PI / 2 },                          // 6 wall, high
      { pos: [0, 0, d / 2 + 2], face: Math.PI / 2, walk: [[-w / 2, 0, d / 2 + 2.1], [w / 2, 0, d / 2 + 2.1]] }, // 7 street walk
      { pos: [-2.4, 0, d / 2 + 2.3], face: Math.PI / 4 },                                          // 8 bench
      { pos: [w / 2 + 2.3, 0, d / 2 + 1.4], face: Math.PI / 4 },                                  // 9 front-right bench
    ];
    return s;
  }

  private builder(parent: THREE.Object3D, pid: string, s: SessionView, mode: Mode, slot: Slot, updaters: Updater[], labels: Label[]) {
    if ((mode === 'walk' || mode === 'carry') && !slot.walk) mode = 'hammer';
    const a = s.agent;
    const sleeper = mode === 'sleep' ? this.sleepers.get(s.id) ?? null : null;
    const mood: Mood = sleeper ? 'out' : s.status === 'needs_input' ? 'needs' : s.stuck ? 'stuck' : s.away ? 'out' : s.status === 'idle' ? 'break' : 'working';
    const crew = buildCrew({ shape: a.shape, color: a.color, accessory: a.accessory, job: a.job, mood, mode: s.stuck && mode !== 'wave' ? 'stuck' : mode }, (c) => this.m(c), { dark: this.dark, glow: s.status === 'needs_input' ? '#e5484d' : s.status === 'running' ? '#17c3c3' : undefined });
    const g = crew.root;
    g.position.set(...slot.pos); g.rotation.y = mode === 'wave' || mode === 'sit' || mode === 'stand' || mode === 'sleep' ? Math.PI / 4 : slot.face; g.scale.setScalar(a.role === 'helper' ? 0.95 : 1.35);
    g.userData.sid = s.id;
    parent.add(g);
    this.crewFigures.push({ g, base: g.scale.x, h: crew.height, pid });
    const arrivedAt = this.arrivals.get(s.id) ?? null, home = g.position.clone(), facing = g.rotation.y;
    // helpers: a half-size copy of the agent tagging along
    let helper: ReturnType<typeof buildCrew> | null = null;
    if (s.helperActive) {
      helper = buildCrew({ shape: a.shape, color: a.color, accessory: a.accessory, job: 'none', mood: 'working', mode: 'walk' }, (c) => this.m(c), { dark: this.dark });
      helper.root.scale.setScalar(0.62); helper.root.userData.sid = s.id; parent.add(helper.root);
    }
    const anchor = new THREE.Object3D(); anchor.position.y = crew.height + 0.25; g.add(anchor);
    // Always-on label: the job they're on, the project, or their current step (a setting); their name appears when you hover or select the building.
    const next = sleeper ? nextRunText(sleeper.nextAt) : null;
    const doing = sleeper ? (next ? `asleep · up ${next}` : 'asleep') : this.bubbleText(s);
    const tag = this.div(`tag doing-${s.status === 'needs_input' ? 'needs' : s.status === 'running' ? 'run' : sleeper ? 'sleep' : 'rest'}`, `<span class="doing">${esc(doing)}</span><span class="grp"></span><span class="who">${esc(a.name)}</span>`);
    tag.dataset.sid = s.id; tag.dataset.status = sleeper ? 'asleep' : s.away ? 'away' : s.status;
    this.label(labels, tag, anchor, 0.42, 'tag', pid);
    if (!sleeper) this.doingEls.set(s.id, tag); // a sleeper's id is its last (ended) run: keep the bubble refresh off it
    if (s.away) { const z = this.div('zzz', 'z<small>z</small><small>z</small>'); z.dataset.sid = s.id; this.label(labels, z, anchor, 0.1, 'fx', pid); }
    const wokeAt = this.waking.get(s.id) ?? null, dozedAt = sleeper ? this.dozing.get(s.id) ?? null : null;
    const nap = wokeAt !== null && Date.now() - wokeAt < 60_000 ? { text: `${a.name} woke up!`, sub: 'Scheduled run', at: wokeAt }
      : dozedAt !== null && Date.now() - dozedAt < 30_000 ? { text: 'Back to sleep', sub: next ? `Up again ${next}` : 'Until next time', at: dozedAt } : null;
    if (nap) {
      const el = this.div('hello', `<b>${esc(nap.text)}</b><span>${esc(nap.sub)}</span>`);
      el.dataset.sid = s.id;
      this.label(labels, el, anchor, 1.25, 'hello', pid);
      setTimeout(() => el.remove(), (wokeAt !== null ? 60_000 : 30_000) - (Date.now() - nap.at));
    }
    const hello = !nap && arrivedAt !== null && Date.now() - arrivedAt < 90_000;
    if (hello) {
      const hi = this.div('hello', `<b>Hi, I’m ${esc(a.name)}!</b><span>New on site</span>`);
      hi.dataset.sid = s.id; hi.dataset.hi = esc(a.name);
      this.label(labels, hi, anchor, 1.9, 'hello', pid);
      setTimeout(() => hi.remove(), 90_000 - (Date.now() - arrivedAt!));
    }
    if (s.chatter && !hello && !nap) {
      const chat = this.div('chat', esc(chatText(s.chatter)));
      chat.dataset.seed = String(hash(s.id) % 997); chat.dataset.sid = s.id;
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
      if (arrivedAt !== null) {
        // walking in from the street toward the camera-facing side of the building, with a little bounce
        const u = Math.min(1, (Date.now() - arrivedAt) / 2600), e = 1 - (1 - u) ** 2;
        if (u < 1) {
          g.position.set(home.x + 6 * (1 - e), home.y * e + Math.abs(Math.sin(u * 22)) * 0.25, home.z + 8 * (1 - e));
          g.rotation.y = Math.atan2(-6, -8);
        } else if (g.userData.walkedIn !== true) { g.userData.walkedIn = true; g.position.copy(home); g.rotation.y = facing; }
      }
      // waking: sit up from the bedroll and hop to it · dozing: lie back down
      if (wokeAt !== null) { const u = Math.min(1, (Date.now() - wokeAt) / 1600); crew.setLie(1 - u * u * (3 - 2 * u)); if (u < 1) g.position.y = home.y + Math.abs(Math.sin(u * Math.PI)) * 0.35; }
      if (dozedAt !== null) { const u = Math.min(1, (Date.now() - dozedAt) / 2200); crew.setLie(u * u * (3 - 2 * u)); }
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
  /** Trees on every empty lot (the parks between neighborhoods) and a street sign naming each neighborhood. */
  private buildParks(districts: StateView['districts'], visible: ProjectView[], graves: boolean) {
    if (this.parkGroup) this.freeObject(this.parkGroup);
    for (const l of this.parkLabels) l.el.remove();
    this.labels = this.labels.filter((l) => !this.parkLabels.includes(l));
    this.parkLabels = [];
    const g = new THREE.Group(); this.scene.add(g); this.parkGroup = g;
    const { minX, maxX, minZ, maxZ } = this.bounds;
    const used = new Set(visible.map((p) => `${p.lot[0]},${p.lot[1]}`));
    if (graves) used.add(`${minX},${maxZ}`);
    used.add(`${minX},${minZ}`); // the café
    for (let x = minX; x <= maxX; x++) for (let z = minZ; z <= maxZ; z++) {
      if (used.has(`${x},${z}`)) continue;
      const r = rand(hash(`${x},${z}`));
      const n = 3 + Math.floor(r() * 3);
      for (let i = 0; i < n; i++) this.tree(x * PITCH + (r() - 0.5) * (LOT - 2), z * PITCH + (r() - 0.5) * (LOT - 2), g, 0.75 + r() * 0.5);
      if (r() < 0.5) { const bench = new THREE.Group(); bench.position.set(x * PITCH + (r() - 0.5) * 3, 0, z * PITCH + (r() - 0.5) * 3); bench.rotation.y = r() * Math.PI; g.add(bench); this.bx(1.2, 0.08, 0.4, '#a0703f', 0, 0.38, 0, bench); this.bx(0.08, 0.38, 0.36, '#5b4632', -0.5, 0, 0, bench); this.bx(0.08, 0.38, 0.36, '#5b4632', 0.5, 0, 0, bench); }
    }
    const shown = new Set(visible.map((p) => p.id));
    for (const d of districts) {
      // only label neighborhoods that have at least one visible building
      if (!visible.some((p) => p.lot[0] >= d.x0 && p.lot[0] <= d.x1 && p.lot[1] >= d.z0 && p.lot[1] <= d.z1 && shown.has(p.id))) continue;
      const anchor = new THREE.Object3D();
      anchor.position.set(((d.x0 + d.x1) / 2) * PITCH, 0, (d.z1 + 0.5) * PITCH);
      g.add(anchor);
      this.label(this.parkLabels, this.div('district', esc(d.name)), anchor, 0, 'district', '');
    }
  }

  /**
   * The café: a coffee kiosk with tables where every agent on a coffee break goes to sit, with a steaming mug, until you're back.
   * It sits at the far end of the extra column at the edge of town. Everything on the patio turns with the camera (like the crew
   * on a building), so the kiosk is always at the back and the tables always face you.
   */
  private buildCafe(crew: SessionView[], key: string) {
    if (this.cafe) { this.freeObject(this.cafe.group); this.dropLabels(this.cafe.labels); }
    const { minX, minZ } = this.bounds;
    const outer = new THREE.Group(); outer.position.set(minX * PITCH, 0, minZ * PITCH); outer.userData.cafe = true; this.scene.add(outer);
    const updaters: Updater[] = [], labels: Label[] = [];
    this.cafe = { group: outer, updaters, labels, key };
    const dk = this.dark;
    // lot and a checkered terracotta patio (square, so it can stay put while the rest turns)
    this.bx(8.4, 0.18, 8.4, dk ? '#a8a294' : '#ece5d4', 0, 0, 0, outer);
    const tileA = dk ? '#9a7458' : '#e8c39a', tileB = dk ? '#86634a' : '#dcae80';
    for (let i = 0; i < 8; i++) for (let j = 0; j < 8; j++) {
      const t = this.bx(0.95, 0.05, 0.95, (i + j) % 2 ? tileA : tileB, -3.325 + i * 0.95, 0.18, -3.325 + j * 0.95, outer); t.castShadow = false;
    }
    const g = new THREE.Group(); g.position.y = BASE; outer.add(g);
    const ring = new THREE.Group(); ring.userData.crewRing = true; ring.rotation.y = this.az - Math.PI / 4; g.add(ring); this.crewRings.push(ring);
    // patio coordinates: u = screen-right, v = toward the camera (the ring keeps them that way at every corner view)
    const P = (u: number, v: number, y = 0): [number, number, number] => [Math.SQRT1_2 * (u + v), y, Math.SQRT1_2 * (v - u)];

    // ---- the kiosk, in the back corner, open on the two sides facing you
    const K = new THREE.Group(); K.position.set(-2, 0, -2); ring.add(K);
    const cream = dk ? '#d9ccb6' : '#f6ead4', wood = '#7a4e2d';
    this.bx(3, 0.9, 3, cream, 0, 0, 0, K);
    this.bx(3.14, 0.08, 3.14, '#c99257', 0, 0.9, 0, K);                    // counter top
    this.bx(2.7, 0.95, 2.7, dk ? '#2f241d' : '#4a3426', -0.1, 0.98, -0.1, K); // dark interior
    for (const [x, z] of [[-1.45, -1.45], [1.45, -1.45], [-1.45, 1.45], [1.45, 1.45]]) this.bx(0.14, 0.95, 0.14, wood, x, 0.98, z, K);
    this.bx(3.3, 0.22, 3.3, wood, 0, 1.93, 0, K);                           // roof
    this.bx(3.36, 0.06, 3.36, cream, 0, 2.15, 0, K);
    // espresso machine, cups and pastries on the counter
    this.bx(0.75, 0.55, 0.45, '#c9ccd1', -0.5, 0.98, 0.9, K);
    this.bx(0.75, 0.08, 0.45, '#8f959c', -0.5, 1.53, 0.9, K);
    this.bx(0.12, 0.12, 0.02, this.winMat('#ffe7a8'), -0.3, 1.3, 1.13, K);
    for (let i = 0; i < 4; i++) this.mesh(new THREE.CylinderGeometry(0.08, 0.065, 0.16, 10), i % 2 ? '#ffffff' : '#e5484d', 0.5 + i * 0.22, 1.06, 1.25, K);
    this.mesh(new THREE.CylinderGeometry(0.22, 0.22, 0.04, 14), '#e9d3a8', 1.1, 1.0, 0.5, K);
    for (let i = 0; i < 3; i++) this.mesh(new THREE.SphereGeometry(0.08, 8, 6), '#c98a3e', 1.02 + i * 0.08, 1.08, 0.45 + (i % 2) * 0.1, K);
    // striped awnings over both open sides
    for (let i = 0; i < 6; i++) {
      const c = i % 2 ? '#fff6e8' : '#e5484d';
      const a = this.bx(0.5, 0.06, 0.9, c, -1.25 + i * 0.5, 1.72, 1.85, K); a.rotation.x = 0.38;
      const b = this.bx(0.9, 0.06, 0.5, c, 1.85, 1.72, -1.25 + i * 0.5, K); b.rotation.z = -0.38;
    }
    // a giant mug on the roof, steaming
    const mug = new THREE.Group(); mug.position.set(0, 2.18, 0); K.add(mug);
    this.mesh(new THREE.CylinderGeometry(0.62, 0.52, 1, 20), '#ffffff', 0, 0.5, 0, mug);
    this.mesh(new THREE.CylinderGeometry(0.56, 0.56, 0.04, 20), '#6b3f22', 0, 0.98, 0, mug);
    this.mesh(new THREE.CylinderGeometry(0.6, 0.57, 0.16, 20), '#e5484d', 0, 0.55, 0, mug);
    const handle = this.mesh(new THREE.TorusGeometry(0.28, 0.08, 8, 16), '#ffffff', 0.62, 0.5, 0, mug); handle.rotation.y = Math.PI / 4;
    this.steam(mug, 0, 1.05, 0, 1.4, updaters, 4);
    // chalkboard A-frame by the counter
    const board = new THREE.Group(); board.position.set(...P(-2.9, -0.4)); board.rotation.y = Math.PI / 4; ring.add(board);
    const f1 = this.bx(0.62, 0.8, 0.05, '#2f3b33', 0, 0, 0.12, board); f1.rotation.x = -0.25;
    const f2 = this.bx(0.62, 0.8, 0.05, '#2f3b33', 0, 0, -0.12, board); f2.rotation.x = 0.25;
    for (let i = 0; i < 3; i++) { const l = this.bx(0.38 - i * 0.08, 0.04, 0.01, '#f4f1e6', 0, 0.55 - i * 0.16, 0.16 + i * 0.04, board); l.rotation.x = -0.25; l.castShadow = false; }

    // ---- string lights along the two back edges, from the kiosk roof out to two posts
    const bulbCols = ['#ffd84d', '#ff9f6b', '#fff3c2', '#9fe3d0'];
    for (const [px, pz] of [[-3.6, 3.6], [3.6, -3.6]]) {
      this.bx(0.1, 2.5, 0.1, '#5b4632', px, 0, pz, ring);
      const from = new THREE.Vector3(px, 2.45, pz), to = new THREE.Vector3(-3.4, 2.2, -3.4);
      for (let i = 1; i < 10; i++) {
        const u = i / 10;
        const bulb = new THREE.Mesh(new THREE.SphereGeometry(0.07, 6, 5), this.winMat(bulbCols[i % bulbCols.length]));
        bulb.position.lerpVectors(from, to, u); bulb.position.y -= Math.sin(u * Math.PI) * 0.35; ring.add(bulb);
      }
    }
    // potted shrubs on the patio corners
    for (const [u, v] of [[-4.3, 0.6], [4.3, 0.6], [0, 4.6]]) {
      const [x, , z] = P(u, v);
      this.mesh(new THREE.CylinderGeometry(0.3, 0.24, 0.42, 10), '#c0583d', x, 0.21, z, ring);
      this.mesh(new THREE.IcosahedronGeometry(0.42, 0), dk ? '#3f7d45' : '#5fae5b', x, 0.72, z, ring);
    }
    if (dk) { const pl = new THREE.PointLight('#ffcf8a', 40, 12, 1.6); pl.position.set(...P(0, 0.8, 4)); ring.add(pl); }

    // ---- tables: a seat either side of each round table; the middle rows fill first, then the queue at the counter
    const tables: [number, number][] = [[-1.7, 1.0], [1.7, 1.0], [0, 3.1], [-2.9, -1.2], [2.9, -1.2]];
    const seats: { u: number; v: number; table: number; side: number }[] = [];
    tables.forEach(([u, v], t) => { seats.push({ u: u - 0.95, v, table: t, side: -1 }, { u: u + 0.95, v, table: t, side: 1 }); });
    for (const [u, v] of tables) {
      const tg = new THREE.Group(); tg.position.set(...P(u, v)); ring.add(tg);
      this.mesh(new THREE.CylinderGeometry(0.5, 0.5, 0.06, 18), '#fffaf0', 0, 0.74, 0, tg);
      this.mesh(new THREE.CylinderGeometry(0.06, 0.06, 0.72, 8), '#59616b', 0, 0.37, 0, tg);
      this.mesh(new THREE.CylinderGeometry(0.28, 0.28, 0.04, 12), '#59616b', 0, 0.02, 0, tg);
    }
    seats.forEach((st, i) => {
      const [tu, tv] = tables[st.table];
      if (crew[i]) {
        // their mug on the table, on their side, steaming
        const m = new THREE.Group(); m.position.set(...P(tu + st.side * 0.22, tv + 0.1, 0.77)); ring.add(m);
        this.mesh(new THREE.CylinderGeometry(0.09, 0.075, 0.18, 10), ['#ffffff', '#9fd9c6', '#f6d36b'][i % 3], 0, 0.09, 0, m);
        this.mesh(new THREE.CylinderGeometry(0.075, 0.075, 0.01, 10), '#6b3f22', 0, 0.18, 0, m);
        this.steam(m, 0, 0.2, 0, 0.7, updaters, 2);
        return;
      }
      // an empty chair, backrest away from the table (screen-right in ring space is (√½, -√½))
      const chair = new THREE.Group(); chair.position.set(...P(st.u, st.v)); ring.add(chair);
      chair.rotation.y = Math.atan2(st.side * Math.SQRT1_2, -st.side * Math.SQRT1_2);
      this.bx(0.42, 0.05, 0.42, '#a0703f', 0, 0.4, 0, chair);
      this.bx(0.06, 0.4, 0.06, '#5b4632', 0, 0, 0, chair);
      this.bx(0.06, 0.5, 0.42, '#a0703f', -0.2, 0.45, 0, chair);
    });
    crew.forEach((s, i) => {
      let slot: Slot = { pos: [0, 0, 0], face: Math.PI / 4 }, mode: Mode = 'sit';
      if (i < seats.length) slot.pos = P(seats[i].u, seats[i].v);
      else {
        // everyone else waits in line at the counter, then mills about the front of the patio
        const q = i - seats.length, k = q - 3, u = ((k % 5) - 2) * 1.1;
        mode = 'stand';
        slot.pos = q < 3 ? P(0.2 + q * 0.9, -0.2 + q * 0.5) : P(u, 4.3 - Math.abs(u) * 0.5 - Math.floor(k / 5) * 0.6);
      }
      this.builder(ring, s.projectId ?? '__cafe', s, mode, slot, updaters, labels);
      // everyone here is on a break, so their tag says who they are (shown when you're close or pointing at the café)
      const tag = this.doingEls.get(s.id);
      if (tag) { tag.dataset.cafe = '1'; tag.innerHTML = `<span class="doing">${esc(s.agent.name)}</span>`; this.doingEls.delete(s.id); }
    });

    // the sign: always on, like the graveyard's
    const sign = new THREE.Object3D(); sign.position.set(-2, 4.1, -2); ring.add(sign);
    const el = this.div('cafe-sign', `Café <small>${crew.length ? `${crew.length} on a break` : 'quiet'}</small>`);
    el.onclick = () => this.focusCafe();
    el.onpointerenter = () => { this.cafeHover = true; };
    el.onpointerleave = () => { this.cafeHover = false; };
    this.label(labels, el, sign, 0, 'fx', '__cafe');
  }

  /** Little puffs of steam rising and fading above a cup. */
  private steam(parent: THREE.Object3D, x: number, y: number, z: number, rise: number, updaters: Updater[], n: number) {
    const puffs = Array.from({ length: n }, () => {
      const m = new THREE.Mesh(new THREE.IcosahedronGeometry(rise * 0.09, 0), new THREE.MeshBasicMaterial({ color: '#ffffff', transparent: true, depthWrite: false }));
      parent.add(m); return m;
    });
    const ph = Math.random() * 10;
    updaters.push((t) => puffs.forEach((m, i) => {
      const k = (t * 0.45 + ph + i / n) % 1;
      m.position.set(x + Math.sin((t + i) * 2) * rise * 0.06, y + k * rise, z + Math.cos((t + i) * 1.7) * rise * 0.04);
      m.scale.setScalar(0.6 + k * 1.2);
      (m.material as THREE.MeshBasicMaterial).opacity = 0.75 * Math.sin(k * Math.PI);
    }));
  }

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
    g.userData.grave = true;
    const signEl = this.div('grave-sign', `Graveyard <small>${graves.length}</small>`);
    signEl.onclick = () => this.opts.onGraveyard?.();
    this.label(this.graveLabels, signEl, sign, 0, 'fx', '__grave');
    graves.slice(0, 12).forEach((e, i) => {
      const x = -2.4 + (i % 4) * 1.6, z = -2 + Math.floor(i / 4) * 1.8;
      const st = new THREE.Group(); st.position.set(x, 0.24, z); st.userData.sid = e.sessionId; g.add(st);
      this.bx(0.8, 0.7, 0.22, '#b8bec7', 0, 0, 0, st);
      const top = this.mesh(new THREE.CylinderGeometry(0.4, 0.4, 0.22, 14, 1, false, 0, Math.PI), '#b8bec7', 0, 0.7, 0, st); top.rotation.set(Math.PI / 2, 0, Math.PI / 2);
      this.bx(0.9, 0.06, 0.5, '#6f8f5f', 0, 0, 0.25, st);
      const a = new THREE.Object3D(); a.position.y = 1.4; st.add(a);
      const rip = this.div('rip hidden-until-zoom', `<b>RIP ${esc(e.agent.name)}</b><span>${esc(e.epitaph)}</span>`);
      rip.onclick = () => this.opts.onAgent?.(e.sessionId);
      this.label(this.graveLabels, rip, a, 0, 'fx', '__grave');
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
    this.stepAnim();
    if (this.held.size) {
      // about half a screen per second, whatever the zoom
      const v = 0.55 * dt, h = this.held;
      this.panBy(((h.has('right') ? 1 : 0) - (h.has('left') ? 1 : 0)) * v, ((h.has('up') ? 1 : 0) - (h.has('down') ? 1 : 0)) * v);
    }
    for (const f of this.globalUpdaters) f(t, dt);
    for (const b of this.buildings.values()) for (const f of b.updaters) f(t, dt);
    if (this.cafe) for (const f of this.cafe.updaters) f(t, dt);
    // Keep every character at least ~30px tall on screen, however far out you zoom.
    const unitsPerPx = (this.cam.top - this.cam.bottom) / Math.max(1, this.renderer.domElement.clientHeight);
    this.crewFigures = this.crewFigures.filter((c) => c.g.parent);
    this.crewRings = this.crewRings.filter((r) => r.parent);
    for (const r of this.crewRings) r.rotation.y = this.az - Math.PI / 4;
    const F = this.hl;
    for (const c of this.crewFigures) c.g.visible = (!F.sessions || F.sessions.has(c.g.userData.sid)) && (!F.projects || F.projects.has(c.pid));
    for (const c of this.crewFigures) c.g.scale.setScalar(c.base * Math.min(2.6, Math.max(1, (30 * unitsPerPx) / (c.h * c.base))));
    this.renderer.render(this.scene, this.cam);
    const el = this.renderer.domElement, W = el.clientWidth, H = el.clientHeight;
    const zoomedIn = this.zoom > 1.4;
    const raised: { L: Label; x: number; y: number }[] = [];
    const tags: { L: Label; x: number; y: number }[] = [];
    const chats: { L: Label; x: number; y: number }[] = [];
    const hellos: { L: Label; x: number; y: number }[] = [];
    const plainNames: { L: Label; x: number; y: number }[] = [];
    const signs: { L: Label; x: number; y: number }[] = []; // café / graveyard signs, "Shipped!" banners: greetings keep off them
    for (const L of this.labels) {
      const st = L.el.dataset.state;
      let show = true;
      if (L.kind === 'tag') {
        const ds = L.el.dataset.status;
        // working / waiting crew always show what they're doing; resting crew only when you're close or looking at their building
        const atCafe = L.el.dataset.cafe === '1';
        show = ds === 'running' || ds === 'needs_input' || zoomedIn || L.pid === this.selected || L.pid === this.hovered || !!F.sessions?.has(L.el.dataset.sid ?? '') || (atCafe && this.cafeHover);
        L.el.classList.toggle('named', L.pid === this.selected || L.pid === this.hovered || (atCafe && this.cafeHover));
      }
      if (L.kind === 'chat') { const seed = Number(L.el.dataset.seed ?? 0); show = L.pid === this.selected || (this.zoom > 1.05 && Math.floor((this.elapsed + seed) / 6) % 3 === 0); }
      if (L.kind === 'bb') {
        const important = st === 'site' || st === 'needs' || L.pid === this.selected || L.pid === this.hovered;
        const focused = !!F.projects?.has(L.pid) || !!(F.sessions && this.focusPids.has(L.pid));
        L.el.classList.toggle('mini', !important && !zoomedIn && !focused);
        L.el.classList.toggle('sel', L.pid === this.selected);
        // zoomed out: only sites with crew on them (or what you've picked) keep a name tag
        show = important || focused || (zoomedIn && st !== 'lot');
      }
      const sid = L.el.dataset.sid;
      if (sid && F.sessions && !F.sessions.has(sid)) show = false;
      if (F.projects && L.pid && !L.pid.startsWith('__') && !F.projects.has(L.pid) && L.kind !== 'district') show = false;
      if (F.sessions && L.kind === 'bb' && !this.focusPids.has(L.pid) && L.pid !== this.selected) show = false;
      if (L.el.classList.contains('hidden-until-zoom')) show = zoomedIn || L.pid === this.hovered || L.pid === this.selected;
      if (!show) { L.el.style.display = 'none'; continue; }
      L.obj.getWorldPosition(this.v); this.v.y += L.dy; this.v.project(this.cam);
      if (this.v.x < -1.2 || this.v.x > 1.2 || this.v.y < -1.2 || this.v.y > 1.2) { L.el.style.display = 'none'; continue; }
      L.el.style.display = '';
      const x = ((this.v.x + 1) / 2) * W, y = ((1 - this.v.y) / 2) * H;
      if (L.kind === 'bb' && (st === 'site' || st === 'needs')) { raised.push({ L, x, y }); continue; }
      if (L.kind === 'tag') { tags.push({ L, x, y }); continue; }
      if (L.kind === 'chat') { chats.push({ L, x, y }); continue; }
      if (L.kind === 'hello') { hellos.push({ L, x, y }); continue; }
      L.el.style.transform = `translate(${x.toFixed(1)}px,${y.toFixed(1)}px) translate(-50%,-100%)`;
      L.el.style.transform = L.kind === 'district' ? `translate(${x.toFixed(1)}px,${y.toFixed(1)}px) translate(-50%,-50%)` : L.el.style.transform;
      L.el.style.zIndex = L.kind === 'district' ? '1' : String(Math.round(1000 - this.v.z * 500) + (L.kind === 'bb' ? 0 : 2000));
      if (L.kind === 'bb' && L.pid !== this.selected && L.pid !== this.hovered) plainNames.push({ L, x, y });
      if (L.kind === 'fx') signs.push({ L, x, y });
    }
    // Resting crew at one site share a single tag ("4 on coffee break") instead of a pile of identical pills.
    // Hover or select the building to see each of them by name again.
    const restGroups = new Map<string, { L: Label; x: number; y: number }[]>();
    for (const r of tags) {
      const ds = r.L.el.dataset.status;
      const open = r.L.pid === this.selected || r.L.pid === this.hovered;
      if (ds === 'running' || ds === 'needs_input' || open) { r.L.el.classList.remove('grouped'); continue; }
      const g = restGroups.get(r.L.pid) ?? []; g.push(r); restGroups.set(r.L.pid, g);
    }
    const hiddenTags = new Set<Label>();
    for (const g of restGroups.values()) {
      if (g.length < 2) { g[0].L.el.classList.remove('grouped'); continue; }
      const lead = g.reduce((a, b) => (b.y > a.y ? b : a)); // the lowest one, nearest the crew
      const doings = new Set(g.map((r) => r.L.el.querySelector('.doing')?.textContent ?? ''));
      const grp = lead.L.el.querySelector('.grp') as HTMLElement | null;
      const text = doings.size === 1 ? `${g.length} on ${[...doings][0]}` : `${g.length} resting`;
      if (grp && grp.textContent !== text) grp.textContent = text;
      lead.L.el.classList.add('grouped');
      lead.x = g.reduce((s, r) => s + r.x, 0) / g.length;
      for (const r of g) if (r !== lead) { r.L.el.classList.remove('grouped'); r.L.el.style.display = 'none'; hiddenTags.add(r.L); }
    }
    // Crew labels: several agents at one site would stack on top of each other, so nudge them apart.
    tags.sort((a, b) => b.y - a.y);
    const tagBoxes: { x: number; y: number; w: number; h: number }[] = [];
    const tagBySid = new Map<string, { x: number; y: number; w: number; h: number }>();
    for (const r of tags) {
      if (hiddenTags.has(r.L)) continue;
      const w = r.L.el.offsetWidth, h = r.L.el.offsetHeight + 2;
      let y = r.y;
      for (let guard = 0, moved = true; moved && guard < 12; guard++) {
        moved = false;
        for (const q of tagBoxes) if (Math.abs(r.x - q.x) < (w + q.w) / 2 + 4 && y > q.y - q.h && y - h < q.y) { y = q.y - q.h; moved = true; }
      }
      const box = { x: r.x, y, w, h };
      tagBoxes.push(box);
      if (r.L.el.dataset.sid) tagBySid.set(r.L.el.dataset.sid, box);
      r.L.el.style.transform = `translate(${r.x.toFixed(1)}px,${y.toFixed(1)}px) translate(-50%,-100%)`;
      r.L.el.style.zIndex = String(3000 + Math.round(y));
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
    // Chat bubbles: one per site at a time, sitting just above the speaker's tag. A bubble that can't find clear
    // space is skipped this time rather than drawn over other labels. It gets another turn on its next cycle.
    const blockers = [...tagBoxes, ...placed];
    const signBoxes = hellos.length || chats.length ? signs.map((r) => ({ x: r.x, y: r.y, w: r.L.el.offsetWidth, h: r.L.el.offsetHeight })) : [];
    // Greetings ("Hi, I'm …! New on site", "… woke up!") go first: just above the agent's tag, stepping up past any
    // project name or crew label in the way. If there's no room above, they drop below what they hit instead.
    // One greeting per site: crew who arrive together (a burst of helpers) share one "N new crew!" bubble.
    const overlaps = (x: number, y: number, w: number, h: number) => (q: { x: number; y: number; w: number; h: number }) => Math.abs(x - q.x) < (w + q.w) / 2 + 6 && y > q.y - q.h && y - h < q.y;
    const hitAt = (x: number, y: number, w: number, h: number) => blockers.find(overlaps(x, y, w, h)) ?? signBoxes.find(overlaps(x, y, w, h));
    const helloSites = new Map<string, { L: Label; x: number; y: number }[]>();
    for (const r of hellos) { if (!r.L.el.isConnected) continue; const g = helloSites.get(r.L.pid) ?? []; g.push(r); helloSites.set(r.L.pid, g); }
    for (const g of helloSites.values()) {
      const lead = g.find((r) => r.L.el.dataset.hi === undefined) ?? g[0]; // a wake-up note wins over arrivals
      for (const r of g) if (r !== lead) r.L.el.style.display = 'none';
      const el = lead.L.el, r = lead;
      if (el.dataset.hi !== undefined) {
        const n = g.filter((q) => q.L.el.dataset.hi !== undefined).length;
        const html = n > 1 ? `<b>${n} new crew!</b><span>New on site</span>` : `<b>Hi, I’m ${el.dataset.hi}!</b><span>New on site</span>`;
        if (el.innerHTML !== html) el.innerHTML = html;
      }
      const own = tagBySid.get(el.dataset.sid ?? '');
      const x = own ? own.x : r.x;
      const w = el.offsetWidth, h = el.offsetHeight + 10;
      const start = own ? own.y - own.h - 6 : r.y;
      let y = start, ok = false;
      for (let guard = 0; guard < 10; guard++) {
        const hit = hitAt(x, y, w, h);
        if (!hit) { ok = y - h >= 0; break; }
        y = hit.y - hit.h - 6;
        if (start - y > 160) break;
      }
      if (!ok) {
        y = start;
        for (let guard = 0; guard < 10; guard++) {
          const hit = hitAt(x, y, w, h);
          if (!hit) { ok = y <= H; break; }
          y = hit.y + h + 6;
          if (y - start > 160) break;
        }
      }
      if (!ok) { el.style.display = 'none'; continue; }
      blockers.push({ x, y, w, h });
      el.style.transform = `translate(${x.toFixed(1)}px,${y.toFixed(1)}px) translate(-50%,-100%)`;
    }
    const chatSites = new Set<string>();
    chats.sort((a, b) => (a.L.pid === this.selected ? -1 : 0) - (b.L.pid === this.selected ? -1 : 0));
    for (const r of chats) {
      const el = r.L.el;
      if (chatSites.has(r.L.pid)) { el.style.display = 'none'; continue; }
      const own = tagBySid.get(el.dataset.sid ?? '');
      const x = own ? own.x : r.x;
      const w = el.offsetWidth, h = el.offsetHeight + 8;
      const start = own ? own.y - own.h - 4 : r.y;
      let y = start, ok = false;
      for (let guard = 0; guard < 8; guard++) {
        const hit = hitAt(x, y, w, h);
        if (!hit) { ok = true; break; }
        y = hit.y - hit.h - 4;
        if (start - y > 90) break; // drifting too far from the speaker: not worth it
      }
      if (!ok || y - h < 0) { el.style.display = 'none'; continue; }
      chatSites.add(r.L.pid);
      blockers.push({ x, y, w, h });
      el.style.transform = `translate(${x.toFixed(1)}px,${y.toFixed(1)}px) translate(-50%,-100%)`;
      el.style.zIndex = String(6000 + Math.round(y));
    }
    // A quiet building's name that sits under crew labels or a bubble steps aside (hover or select brings it back).
    for (const r of plainNames) {
      const w = r.L.el.offsetWidth, h = r.L.el.offsetHeight;
      if (blockers.some((q) => Math.abs(r.x - q.x) < (w + q.w) / 2 + 4 && r.y > q.y - q.h && r.y - h < q.y)) r.L.el.style.display = 'none';
    }
  };
}
