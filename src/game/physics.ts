import RAPIER from '@dimforge/rapier3d-compat';
import * as THREE from 'three';

export { RAPIER };

let ready: Promise<void> | null = null;

export function initPhysics(): Promise<void> {
  ready ??= RAPIER.init();
  return ready;
}

export function toVec(v: { x: number; y: number; z: number }): THREE.Vector3 {
  return new THREE.Vector3(v.x, v.y, v.z);
}

// Ray and shape queries that only hit the static room.
export const STATIC_ONLY =
  RAPIER.QueryFilterFlags.EXCLUDE_DYNAMIC | RAPIER.QueryFilterFlags.EXCLUDE_KINEMATIC;
// Queries that only hit loose objects.
export const DYNAMIC_ONLY =
  RAPIER.QueryFilterFlags.EXCLUDE_FIXED | RAPIER.QueryFilterFlags.EXCLUDE_KINEMATIC;

// Collects all mesh vertices under `root` into the local frame of `frame`
// (position and rotation only; scale is baked into the points).
export function collectPoints(
  root: THREE.Object3D,
  frame: THREE.Matrix4,
  skip?: (obj: THREE.Object3D) => boolean,
): Float32Array {
  const inv = frame.clone().invert();
  const out: number[] = [];
  const v = new THREE.Vector3();
  const m = new THREE.Matrix4();
  root.updateWorldMatrix(true, true);
  const visit = (obj: THREE.Object3D) => {
    if (skip?.(obj)) return;
    if ((obj as THREE.Mesh).isMesh) {
      const pos = (obj as THREE.Mesh).geometry.getAttribute('position');
      m.multiplyMatrices(inv, obj.matrixWorld);
      for (let i = 0; i < pos.count; i++) {
        v.fromBufferAttribute(pos, i).applyMatrix4(m);
        out.push(v.x, v.y, v.z);
      }
    }
    for (const child of obj.children) visit(child);
  };
  visit(root);
  return new Float32Array(out);
}

// Builds a static convex-hull collider description from a mesh in world space.
// Hulls are solid, so thin props can't sink through them like they can with
// triangle meshes; concave furniture is split into several `-col` meshes.
// `adjust` may move the points (world space, Y up) before the hull is built.
export function hullFromMesh(
  mesh: THREE.Mesh,
  adjust?: (points: Float32Array) => void,
): InstanceType<typeof RAPIER.ColliderDesc> | null {
  const points = collectPoints(mesh, new THREE.Matrix4());
  adjust?.(points);
  return RAPIER.ColliderDesc.convexHull(points);
}

type ColliderDesc = InstanceType<typeof RAPIER.ColliderDesc>;

// Points closer than this (m) count as the same ring height or radius.
const RING_TOLERANCE = 0.0005;
// Rapier's hull-on-hull contacts stay stable up to about this many points per ring.
const MAX_RING_POINTS = 12;

// Collider shapes for a prop from its points (local frame, Y up), each with
// its share of the prop's mass.
//
// Rapier's convex hull contacts break down on faces with many vertices:
// props built from 24-32-sided rings creep across tables on their own, and
// stacked ones sink into each other. So round props (every vertex on a ring
// around the vertical axis) become a stack of cylinders that follows their
// profile, and anything else gets its hull with each ring thinned out.
export function propColliders(points: Float32Array): { desc: ColliderDesc; share: number }[] {
  const box = new THREE.Box3().setFromArray(points);
  const cx = (box.min.x + box.max.x) / 2;
  const cz = (box.min.z + box.max.z) / 2;
  const levels = ringLevels(points, cx, cz);

  if (isLathe(levels, points, cx, cz)) {
    const cylinders = cylinderStack(levels);
    const total = cylinders.reduce((sum, c) => sum + c.r * c.r * (c.y1 - c.y0), 0);
    return cylinders.map((c) => ({
      desc: RAPIER.ColliderDesc.cylinder((c.y1 - c.y0) / 2, c.r).setTranslation(cx, (c.y0 + c.y1) / 2, cz),
      share: (c.r * c.r * (c.y1 - c.y0)) / total,
    }));
  }

  const hull = RAPIER.ColliderDesc.convexHull(thinRings(points, cx, cz)) ?? RAPIER.ColliderDesc.ball(0.05);
  return [{ desc: hull, share: 1 }];
}

interface RingLevel {
  y: number;
  // Distance of each point at this height from the vertical axis.
  radii: number[];
  // Each point's index into the points array.
  indices: number[];
}

// Groups points by height, bottom to top.
function ringLevels(points: Float32Array, cx: number, cz: number): RingLevel[] {
  const order = Array.from({ length: points.length / 3 }, (_, i) => i).sort((a, b) => points[a * 3 + 1] - points[b * 3 + 1]);
  const levels: RingLevel[] = [];
  for (const i of order) {
    const y = points[i * 3 + 1];
    const r = Math.hypot(points[i * 3] - cx, points[i * 3 + 2] - cz);
    let level = levels[levels.length - 1];
    if (!level || y - level.y > RING_TOLERANCE) {
      level = { y, radii: [], indices: [] };
      levels.push(level);
    }
    level.radii.push(r);
    level.indices.push(i * 3);
  }
  return levels;
}

// True when (nearly) every point lies on the axis or on a ring around it, as
// in a mug, plate, bottle or egg. A ring needs at least six points spread
// all the way round, so a box's four equidistant corners don't count.
function isLathe(levels: RingLevel[], points: Float32Array, cx: number, cz: number): boolean {
  let onRings = 0;
  for (const level of levels) {
    const order = level.radii.map((_, k) => k).sort((a, b) => level.radii[a] - level.radii[b]);
    let start = 0;
    for (let i = 1; i <= order.length; i++) {
      if (i < order.length && level.radii[order[i]] - level.radii[order[i - 1]] <= RING_TOLERANCE) continue;
      const ring = order.slice(start, i);
      start = i;
      if (level.radii[ring[0]] <= RING_TOLERANCE) {
        onRings += ring.length;
        continue;
      }
      const angles = ring
        .map((k) => Math.atan2(points[level.indices[k] + 2] - cz, points[level.indices[k]] - cx))
        .sort((a, b) => a - b);
      let gap = angles[0] + Math.PI * 2 - angles[angles.length - 1];
      for (let j = 1; j < angles.length; j++) gap = Math.max(gap, angles[j] - angles[j - 1]);
      if (ring.length >= 6 && gap <= Math.PI / 2.5) onRings += ring.length;
    }
  }
  return onRings >= (points.length / 3) * 0.95;
}

// Cylinders whose radii follow the outer profile of a round prop. Sloped
// sections are split so the stack doesn't stick out much past the mesh.
function cylinderStack(levels: RingLevel[]): { y0: number; y1: number; r: number }[] {
  const profile = levels.map((l) => ({ y: l.y, r: Math.max(...l.radii) }));
  const pieces: { y0: number; y1: number; r: number }[] = [];
  for (let i = 0; i + 1 < profile.length; i++) {
    const a = profile[i];
    const b = profile[i + 1];
    const steps = THREE.MathUtils.clamp(Math.ceil(Math.abs(b.r - a.r) / 0.01), 1, 4);
    for (let k = 0; k < steps; k++) {
      const r = Math.max(THREE.MathUtils.lerp(a.r, b.r, k / steps), THREE.MathUtils.lerp(a.r, b.r, (k + 1) / steps));
      const y0 = THREE.MathUtils.lerp(a.y, b.y, k / steps);
      const y1 = THREE.MathUtils.lerp(a.y, b.y, (k + 1) / steps);
      const last = pieces[pieces.length - 1];
      // Merge neighbours of similar radius to keep the collider count down.
      if (last && Math.abs(last.r - r) <= 0.1 * Math.max(last.r, r)) {
        last.y1 = y1;
        last.r = Math.max(last.r, r);
      } else {
        pieces.push({ y0, y1, r });
      }
    }
  }
  return pieces.filter((p) => p.y1 - p.y0 > 1e-4 && p.r > 1e-4);
}

// Keeps at most MAX_RING_POINTS points per ring height: the outermost one in
// each slice of angle around the vertical axis. Heights with few points
// (boxes) are kept as they are.
function thinRings(points: Float32Array, cx: number, cz: number): Float32Array {
  const out: number[] = [];
  for (const level of ringLevels(points, cx, cz)) {
    // Meshes repeat a vertex for each face with its own normal; count each spot once.
    const spots = new Set(level.indices.map((p) => `${Math.round(points[p] / RING_TOLERANCE)},${Math.round(points[p + 2] / RING_TOLERANCE)}`));
    if (spots.size <= MAX_RING_POINTS) {
      for (const p of level.indices) out.push(points[p], points[p + 1], points[p + 2]);
      continue;
    }
    const best = new Map<number, number>();
    level.indices.forEach((p, k) => {
      const angle = Math.atan2(points[p + 2] - cz, points[p] - cx) + Math.PI;
      const slice = level.radii[k] <= RING_TOLERANCE ? -1 : Math.floor((angle / (Math.PI * 2)) * MAX_RING_POINTS) % MAX_RING_POINTS;
      const cur = best.get(slice);
      if (cur === undefined || level.radii[k] > level.radii[cur]) best.set(slice, k);
    });
    for (const k of best.values()) {
      const p = level.indices[k];
      out.push(points[p], points[p + 1], points[p + 2]);
    }
  }
  return new Float32Array(out);
}

// World transform of an object without its scale.
export function unscaledWorldMatrix(obj: THREE.Object3D): THREE.Matrix4 {
  obj.updateWorldMatrix(true, false);
  const p = new THREE.Vector3();
  const q = new THREE.Quaternion();
  const s = new THREE.Vector3();
  obj.matrixWorld.decompose(p, q, s);
  return new THREE.Matrix4().compose(p, q, new THREE.Vector3(1, 1, 1));
}
