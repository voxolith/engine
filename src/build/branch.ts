// Branching structures: polylines with radii, grown before any voxel exists.
//
// Trees, bushes, roots, corals and lightning are all the same problem — a
// recursive structure of tapering segments — so this lives in the toolkit
// rather than in any one generator.
//
// Three rules carry most of the quality. Children start on the parent's axis,
// so the first voxel a child writes is already inside solid parent material and
// the result stays one connected piece. Child radius follows a pipe model, so a
// fork conserves visual mass instead of looking like pins stuck into a pole.
// And the direction wobble is coherent noise sampled in space, not per-step
// random numbers, which is the difference between character and a noodle.

import type { Vec3 } from "../entity";
import type { Noise } from "./noise";
import { smoothstep } from "./noise";
import { add, frame, normalize, scale } from "./shapes";

/** Where a level-0 stem starts. Trees pass one; a bush passes several. */
export interface StemSeed {
  origin: Vec3;
  dir: Vec3;
  length: number;
  radius: number;
}

/** Growth rules for one level of children. Index 0 describes level 1. */
export interface BranchLevel {
  /** Children per parent, inclusive range. */
  count: [number, number];
  /** Child length as a fraction of the parent's. */
  lenRatio: number;
  /** Random spread on that length, as ±fraction. */
  lenVar: number;
  /** Angle away from the parent axis. */
  downDeg: number;
  downVarDeg: number;
  /** Arc length between polyline points, in voxels. */
  segLen: number;
  /** Downward bend per voxel travelled; thin stems get more. */
  gravity: number;
  /** Upward bend per voxel travelled, ramped toward the tip. */
  photo: number;
  /** Amplitude of the coherent direction wobble. */
  curl: number;
}

export interface BranchParams {
  seeds: StemSeed[];
  /** Level-0 behaviour: how the trunk itself tapers, curves and is sampled. */
  base: {
    taperExp: number;
    /** Total lateral turn over the stem's length. */
    sweepDeg: number;
    curl: number;
    segLen: number;
    /** Downward bend per voxel. A trunk uses 0; a grass blade arcs right over. */
    gravity?: number;
    photo?: number;
  };
  /** First and last child position along a level-0 stem, as fractions. */
  childStart: number;
  childEnd: number;
  /** Where the longest children sit: "mid" peaks mid-stem, "taper" shortens with height. */
  envelope: "mid" | "taper";
  azimuthJitterDeg: number;
  /** 0 spawns children alternately; >0 spawns whorls of this many at once. */
  whorl: number;
  /** Distance between whorls, in voxels. */
  whorlSpacing: number;
  /** Higher keeps child branches thicker at forks. */
  pipeExp: number;
  /** Taper exponent for levels above 0. */
  branchTaper: number;
  minRadius: number;
  levels: BranchLevel[];
  /** Multiplier on every `segLen`, so one parameter set works at any scale. */
  unit?: number;
  maxStems?: number;
  maxSegments?: number;
}

export interface Stem {
  id: number;
  level: number;
  parent: number;
  points: Vec3[];
  radii: number[];
  /** Arc length from the stem base at each point. */
  arc: number[];
  length: number;
  /** Index of the seed this stem ultimately grew from. */
  seed: number;
}

export interface Segment {
  stem: number;
  level: number;
  a: Vec3;
  b: Vec3;
  ra: number;
  rb: number;
  /** Arc length at `a`, measured along the stem from its base. */
  u: number;
}

export interface Tip {
  p: Vec3;
  dir: Vec3;
  level: number;
  stem: number;
}

export interface Skeleton {
  stems: Stem[];
  segments: Segment[];
  tips: Tip[];
  /** Highest point reached. */
  topY: number;
  /** Largest horizontal distance from the origin. */
  spread: number;
  /** Heights at which whorls were placed, when whorls are in use. */
  whorlY: number[];
}

const GOLDEN = 2.399963229728653; // radians, 137.507°

interface Task {
  origin: Vec3;
  dir: Vec3;
  len: number;
  r0: number;
  level: number;
  parent: number;
  seed: number;
}

export function growBranches(p: BranchParams, rng: () => number, noise: Noise): Skeleton {
  const unit = p.unit ?? 1;
  const maxStems = p.maxStems ?? 20000;
  const maxSegments = p.maxSegments ?? 60000;
  const stems: Stem[] = [];
  const segments: Segment[] = [];
  const tips: Tip[] = [];
  const whorlY: number[] = [];
  let azCounter = 0;

  const deg = (d: number) => (d * Math.PI) / 180;
  const jitter = (amount: number) => (rng() * 2 - 1) * amount;

  const sweepAz = rng() * Math.PI * 2;
  const sweepAxis: Vec3 = [Math.cos(sweepAz), 0, Math.sin(sweepAz)];

  const queue: Task[] = p.seeds.map((s, i) => ({
    origin: [s.origin[0], s.origin[1], s.origin[2]],
    dir: normalize(s.dir),
    len: s.length,
    r0: s.radius,
    level: 0,
    parent: -1,
    seed: i,
  }));

  while (queue.length > 0 && stems.length < maxStems && segments.length < maxSegments) {
    const task = queue.shift()!;
    const lv = task.level === 0 ? null : p.levels[Math.min(task.level - 1, p.levels.length - 1)];
    const segLen = (task.level === 0 ? p.base.segLen : lv!.segLen) * unit;
    const n = Math.max(2, Math.round(task.len / Math.max(0.5, segLen)));
    const step = task.len / n;
    const taper = task.level === 0 ? p.base.taperExp : p.branchTaper;
    const gravity = task.level === 0 ? (p.base.gravity ?? 0) : lv!.gravity;
    const photo = task.level === 0 ? (p.base.photo ?? 0.002) : lv!.photo;
    const curl = task.level === 0 ? p.base.curl : lv!.curl;
    const sweepRate = task.level === 0 ? deg(p.base.sweepDeg) / Math.max(1, task.len) : 0;

    const radiusAt = (t: number): number => Math.max(p.minRadius, task.r0 * Math.pow(Math.max(0, 1 - t), taper));

    // Decide where children attach before marching, so the walk stays simple.
    const children: { t: number; az: number }[] = [];
    const canBranch = task.level < p.levels.length;
    if (canBranch) {
      const start = task.level === 0 ? p.childStart : 0.25;
      const end = task.level === 0 ? p.childEnd : 0.95;
      if (p.whorl > 0 && task.level === 0) {
        const spacing = Math.max(2, p.whorlSpacing);
        for (let u = start * task.len; u < end * task.len; u += spacing) {
          const base = GOLDEN * whorlY.length;
          whorlY.push(u);
          for (let k = 0; k < p.whorl; k++) {
            children.push({
              t: u / task.len,
              az: base + (k / p.whorl) * Math.PI * 2 + jitter(deg(p.azimuthJitterDeg)),
            });
          }
        }
      } else {
        const next = p.levels[Math.min(task.level, p.levels.length - 1)];
        const count = Math.round(next.count[0] + rng() * (next.count[1] - next.count[0]));
        for (let k = 0; k < count; k++) {
          const t = start + ((end - start) * (k + 0.5 + jitter(0.35))) / count;
          children.push({
            t: Math.max(0.05, Math.min(0.98, t)),
            az: GOLDEN * azCounter++ + jitter(deg(p.azimuthJitterDeg)),
          });
        }
      }
      children.sort((a, b) => a.t - b.t);
    }

    const id = stems.length;
    const points: Vec3[] = [task.origin];
    const radii: number[] = [task.r0];
    const arc: number[] = [0];
    let dir = task.dir;
    let pos = task.origin;
    let u = 0;
    let nextChild = 0;

    for (let i = 1; i <= n; i++) {
      const t = i / n;
      const r = radiusAt((i - 0.5) / n);

      // Thin stems droop more, but the ratio is capped: uncapped, the tip of
      // every limb nosedives once its radius falls below a voxel.
      const rFactor = Math.min(1.5, Math.pow(1.2 / Math.max(r, 0.6), 0.8));
      const sag = gravity * step * rFactor;
      const lift = photo * step * smoothstep(0.35, 1, t);
      // The wobble is coherent, so its per-step nudge accumulates along the
      // whole stem; without this scale a curl of 0.03 bends a limb past 90°.
      const w = curl * step * 0.12;
      const wob: Vec3 = [
        noise.signed3(pos[0] * 0.05, pos[1] * 0.05, pos[2] * 0.05, 1),
        noise.signed3(pos[0] * 0.05, pos[1] * 0.05, pos[2] * 0.05, 2) * 0.4,
        noise.signed3(pos[0] * 0.05, pos[1] * 0.05, pos[2] * 0.05, 3),
      ];
      dir = normalize([
        dir[0] + wob[0] * w + sweepAxis[0] * sweepRate * step,
        dir[1] - sag + lift + wob[1] * w,
        dir[2] + wob[2] * w + sweepAxis[2] * sweepRate * step,
      ]);

      const prev = pos;
      pos = add(pos, scale(dir, step));
      u += step;
      points.push(pos);
      radii.push(radiusAt(t));
      arc.push(u);
      segments.push({ stem: id, level: task.level, a: prev, b: pos, ra: radii[i - 1], rb: radii[i], u: arc[i - 1] });

      // Spawn any children whose attachment point we just passed. They start on
      // the parent axis, which is what guarantees connectivity.
      while (canBranch && nextChild < children.length && children[nextChild].t <= t) {
        const c = children[nextChild++];
        const nextLv = p.levels[Math.min(task.level, p.levels.length - 1)];
        const childLen = task.len * nextLv.lenRatio * envelopeAt(p.envelope, c.t) * (1 + jitter(nextLv.lenVar));
        const rHere = radiusAt(c.t);
        if (rHere <= p.minRadius * 1.05) continue; // the parent is already a twig
        const childR = Math.max(
          p.minRadius,
          Math.min(rHere * 0.9, rHere * Math.pow(Math.max(0.05, childLen / task.len), 1 / p.pipeExp)),
        );
        if (childLen < 1.5 * segLen) continue;
        const [f, s, up2] = frame(dir);
        const down = deg(nextLv.downDeg + jitter(nextLv.downVarDeg));
        const lat: Vec3 = [
          s[0] * Math.cos(c.az) + up2[0] * Math.sin(c.az),
          s[1] * Math.cos(c.az) + up2[1] * Math.sin(c.az),
          s[2] * Math.cos(c.az) + up2[2] * Math.sin(c.az),
        ];
        const cdir = normalize([
          f[0] * Math.cos(down) + lat[0] * Math.sin(down),
          f[1] * Math.cos(down) + lat[1] * Math.sin(down),
          f[2] * Math.cos(down) + lat[2] * Math.sin(down),
        ]);
        queue.push({
          origin: pos,
          dir: cdir,
          len: childLen,
          r0: childR,
          level: task.level + 1,
          parent: id,
          seed: task.seed,
        });
      }
    }

    stems.push({ id, level: task.level, parent: task.parent, points, radii, arc, length: task.len, seed: task.seed });
    if (task.level >= p.levels.length - 1) tips.push({ p: pos, dir, level: task.level, stem: id });
  }

  let topY = 0;
  let spread = 0;
  for (const s of stems)
    for (const pt of s.points) {
      if (pt[1] > topY) topY = pt[1];
      const d = Math.hypot(pt[0], pt[2]);
      if (d > spread) spread = d;
    }

  return { stems, segments, tips, topY, spread, whorlY };
}

function envelopeAt(mode: "mid" | "taper", t: number): number {
  if (mode === "taper") return Math.pow(Math.max(0.06, 1 - t * 0.92), 0.85);
  return 1 - Math.abs(t - 0.45);
}

/**
 * Uniformly scale positions so the structure's top sits at `targetTop`. Growth
 * is open-ended, so this is what turns a requested height into an exact knob.
 * Radii are deliberately left alone: thickness is set by the caller and scaling
 * it again here turns a slim trunk into a fat one.
 */
export function fitHeight(skel: Skeleton, targetTop: number): number {
  if (skel.topY <= 0) return 1;
  const s = targetTop / skel.topY;
  if (Math.abs(s - 1) < 1e-3) return 1;
  // Points are shared: a child's first point is the very point on its parent
  // where it attached, and segments and tips alias the stem polylines. Scaling
  // by identity keeps every point scaled exactly once.
  const scaled = new Set<Vec3>();
  const scalePoint = (pt: Vec3) => {
    if (scaled.has(pt)) return;
    scaled.add(pt);
    pt[0] *= s;
    pt[1] *= s;
    pt[2] *= s;
  };
  for (const stem of skel.stems) {
    for (const pt of stem.points) scalePoint(pt);
    for (let i = 0; i < stem.arc.length; i++) stem.arc[i] *= s;
    stem.length *= s;
  }
  for (const seg of skel.segments) {
    scalePoint(seg.a);
    scalePoint(seg.b);
    seg.u *= s;
  }
  for (const t of skel.tips) scalePoint(t.p);
  skel.topY *= s;
  skel.spread *= s;
  return s;
}

/**
 * Orthonormal frames for every segment, packed as 9 floats each (forward,
 * side, up). Surface passes such as bark need these to recover a cylindrical
 * coordinate for a voxel.
 */
export function segmentFrames(segments: Segment[]): { frames: Float32Array; lengths: Float32Array } {
  const frames = new Float32Array(segments.length * 9);
  const lengths = new Float32Array(segments.length);
  for (let i = 0; i < segments.length; i++) {
    const s = segments[i];
    const d: Vec3 = [s.b[0] - s.a[0], s.b[1] - s.a[1], s.b[2] - s.a[2]];
    lengths[i] = Math.hypot(d[0], d[1], d[2]) || 1;
    const [f, side, up2] = frame(d);
    frames.set([f[0], f[1], f[2], side[0], side[1], side[2], up2[0], up2[1], up2[2]], i * 9);
  }
  return { frames, lengths };
}
