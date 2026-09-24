// Playing clips on one entity: the current clip, a crossfade from the last
// one, and the events that fired since the previous update.

import type { Clip, ClipEvent, Entity } from "../entity";
import { blendPoses, clipTime, restPose, sampleClip, type Pose } from "./pose";

export interface Animator {
  /** Switch to a clip, crossfading over `fade` seconds (default 0.2). */
  play(id: string, opts?: { fade?: number; restart?: boolean; speed?: number }): void;
  /** Advance; returns the events crossed since the last update. */
  update(dt: number): ClipEvent[];
  pose(): Pose;
  clip(): string;
  /** Seconds into the current clip (wrapped for loops). */
  time(): number;
  /** A non-looping clip has reached its end. */
  finished(): boolean;
}

export function makeAnimator(entity: Entity, initial?: string): Animator {
  const clips = new Map((entity.clips ?? []).map((c) => [c.id, c]));
  const n = entity.rig?.bones.length ?? 0;
  const first = initial ?? entity.clips?.[0]?.id;
  let cur: Clip | undefined = first ? clips.get(first) : undefined;
  let t = 0, speed = 1;
  let prev: Clip | undefined, prevT = 0, fade = 0, fadeT = 0;
  const a = restPose(n), b = restPose(n), out = restPose(n);

  return {
    play(id, opts = {}) {
      const next = clips.get(id);
      if (!next) throw new Error(`no clip "${id}"`);
      speed = opts.speed ?? 1;
      if (next === cur && !opts.restart) return;
      prev = cur;
      prevT = t;
      cur = next;
      t = 0;
      fade = Math.max(0, opts.fade ?? 0.2);
      fadeT = 0;
    },
    update(dt) {
      const events: ClipEvent[] = [];
      if (!cur) return events;
      const step = dt * speed;
      const t0 = t, t1 = t + step;
      for (const e of cur.events ?? []) {
        if (cur.loop) {
          // Count every crossing, including wraps.
          const d = cur.duration;
          const k0 = Math.floor((t0 - e.t) / d), k1 = Math.floor((t1 - e.t) / d);
          if (k1 > k0) events.push(e);
        } else if (e.t > t0 && e.t <= t1) events.push(e);
      }
      t = t1;
      if (prev) prevT += step;
      if (fade > 0) fadeT = Math.min(fade, fadeT + dt);
      return events;
    },
    pose() {
      if (!cur) return out;
      sampleClip(cur, t, n, b);
      if (!prev || fade <= 0 || fadeT >= fade) return b;
      sampleClip(prev, prevT, n, a);
      return blendPoses(a, b, fadeT / fade, out);
    },
    clip: () => cur?.id ?? "",
    time: () => (cur ? clipTime(cur, t) : 0),
    finished: () => !!cur && !cur.loop && t >= cur.duration,
  };
}
