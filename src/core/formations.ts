import type { Vec3 } from "./state/GameState";
import type { FormationId } from "./runtimeTuning";

export function squadCentroid(positions: Vec3[]): Vec3 {
  let x = 0;
  let z = 0;
  let y = 0;
  for (const p of positions) {
    x += p.x;
    z += p.z;
    y += p.y;
  }
  const n = Math.max(1, positions.length);
  return { x: x / n, y: y / n, z: z / n };
}

/** Unit forward on XZ toward target (default +Z if degenerate). */
export function marchDirectionXZ(centroid: Vec3, target: Vec3): { fx: number; fz: number } {
  let dx = target.x - centroid.x;
  let dz = target.z - centroid.z;
  const len = Math.hypot(dx, dz);
  if (len < 1e-4) return { fx: 0, fz: 1 };
  return { fx: dx / len, fz: dz / len };
}

/**
 * Destination slots for a squad. `target` is the click point; formation is built facing from centroid → target.
 */
export function computeFormationSlots(
  formation: FormationId,
  count: number,
  target: Vec3,
  centroid: Vec3,
  spacing: number,
  circleRadiusPerSqrtUnit: number,
  triangleApexLead: number
): Vec3[] {
  const y = target.y;
  if (count <= 0) return [];
  if (formation === "none" || count === 1) {
    return Array.from({ length: count }, () => ({ x: target.x, y, z: target.z }));
  }

  const { fx, fz } = marchDirectionXZ(centroid, target);
  const rx = -fz;
  const rz = fx;

  if (formation === "circle") {
    const r = spacing * circleRadiusPerSqrtUnit * Math.sqrt(Math.max(1, count));
    return Array.from({ length: count }, (_, k) => {
      const ang = (2 * Math.PI * k) / count;
      const cx = Math.cos(ang);
      const sn = Math.sin(ang);
      return {
        x: target.x + r * cx * rx + r * sn * fx,
        y,
        z: target.z + r * cx * rz + r * sn * fz
      };
    });
  }

  if (formation === "triangle") {
    const slots: Vec3[] = [];
    slots.push({
      x: target.x + fx * spacing * triangleApexLead,
      y,
      z: target.z + fz * spacing * triangleApexLead
    });
    const baseBack = spacing * 1.25;
    const baseCenterX = target.x - fx * baseBack;
    const baseCenterZ = target.z - fz * baseBack;
    const rest = count - 1;
    if (rest <= 0) return slots;
    const half = (spacing * Math.max(1, rest - 1)) * 0.5;
    for (let i = 0; i < rest; i++) {
      const t = rest === 1 ? 0 : (i / (rest - 1)) * 2 - 1;
      slots.push({
        x: baseCenterX + rx * t * half,
        y,
        z: baseCenterZ + rz * t * half
      });
    }
    return slots;
  }

  // square / rectangle grid, facing march direction
  const cols = Math.ceil(Math.sqrt(count));
  const rows = Math.ceil(count / cols);
  const slots: Vec3[] = [];
  let idx = 0;
  for (let row = 0; row < rows && idx < count; row++) {
    for (let col = 0; col < cols && idx < count; col++) {
      const ox = (col - (cols - 1) / 2) * spacing;
      const oz = (row - (rows - 1) / 2) * spacing;
      slots.push({
        x: target.x + rx * ox - fx * oz,
        y,
        z: target.z + rz * ox - fz * oz
      });
      idx++;
    }
  }
  return slots;
}
