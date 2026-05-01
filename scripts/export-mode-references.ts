import fs from "node:fs/promises";
import path from "node:path";
import * as THREE from "three";
import {
  GRID_CELL_SIZE,
  GRID_ORIGIN_X,
  GRID_ORIGIN_Z,
  GROUND_HALF_EXTENT,
  WORLD_PLAY_SPAN_METERS
} from "../src/core/world/worldGrid";
import {
  SPHERE_LAMBDA_MAX,
  SPHERE_MOON_RADIUS,
  SPHERE_THETA_MIN,
  SPHERE_THETA_SPAN,
  sphereCraterDisplacementMeters,
  sphereCraterStamps
} from "../src/core/world/sphereTerrain";

const NASA_MOON_PREVIEW_JPG =
  "https://svs.gsfc.nasa.gov/vis/a000000/a014900/a014959/Moon-Model-Preview-Flat.jpg";

async function writeJson(filePath: string, data: unknown): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, JSON.stringify(data, null, 2) + "\n", "utf8");
}

async function writeText(filePath: string, data: string): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, data, "utf8");
}

function geometryToObj(geometry: THREE.BufferGeometry, objectName: string): string {
  const g = geometry.index ? geometry.toNonIndexed() : geometry.clone();
  const pos = g.getAttribute("position");
  const normal = g.getAttribute("normal");
  let out = `o ${objectName}\n`;
  for (let i = 0; i < pos.count; i += 1) {
    out += `v ${pos.getX(i)} ${pos.getY(i)} ${pos.getZ(i)}\n`;
  }
  for (let i = 0; i < normal.count; i += 1) {
    out += `vn ${normal.getX(i)} ${normal.getY(i)} ${normal.getZ(i)}\n`;
  }
  for (let i = 0; i < pos.count; i += 3) {
    const a = i + 1;
    const b = i + 2;
    const c = i + 3;
    out += `f ${a}//${a} ${b}//${b} ${c}//${c}\n`;
  }
  return out;
}

async function downloadTexture(url: string, outPath: string): Promise<void> {
  try {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const bytes = new Uint8Array(await res.arrayBuffer());
    await fs.mkdir(path.dirname(outPath), { recursive: true });
    await fs.writeFile(outPath, bytes);
  } catch (err) {
    await fs.mkdir(path.dirname(outPath), { recursive: true });
    await fs.writeFile(
      outPath.replace(/\.(jpg|jpeg|png|webp)$/i, ".txt"),
      `Texture download failed from: ${url}\nReason: ${String(err)}\n`,
      "utf8"
    );
  }
}

async function main(): Promise<void> {
  const root = process.cwd();
  const outRoot = path.join(root, "exports", "modes");
  const craterStamps = [...sphereCraterStamps()];

  await writeJson(path.join(outRoot, "flat", "mode-reference.json"), {
    mode: "flat",
    units: "meters",
    gridCellSize: GRID_CELL_SIZE,
    gridOrigin: { x: GRID_ORIGIN_X, z: GRID_ORIGIN_Z },
    groundHalfExtent: GROUND_HALF_EXTENT,
    worldSpanMeters: WORLD_PLAY_SPAN_METERS
  });

  await writeJson(path.join(outRoot, "sphere", "mode-reference.json"), {
    mode: "sphere",
    units: "meters",
    moonRadius: SPHERE_MOON_RADIUS,
    gridCellSize: GRID_CELL_SIZE,
    gridOrigin: { x: GRID_ORIGIN_X, z: GRID_ORIGIN_Z },
    groundHalfExtent: GROUND_HALF_EXTENT,
    worldSpanMeters: WORLD_PLAY_SPAN_METERS,
    mapping: {
      lambdaMax: SPHERE_LAMBDA_MAX,
      thetaMin: SPHERE_THETA_MIN,
      thetaSpan: SPHERE_THETA_SPAN
    },
    craterCount: craterStamps.length
  });

  await writeJson(path.join(outRoot, "sphere", "crater-stamps.json"), craterStamps);

  // Export simple geometry references as OBJ so DCC tools can import immediately.
  const flatGeo = new THREE.PlaneGeometry(WORLD_PLAY_SPAN_METERS, WORLD_PLAY_SPAN_METERS, 1, 1);
  flatGeo.rotateX(-Math.PI / 2);
  flatGeo.computeVertexNormals();
  await writeText(
    path.join(root, "exports", "models", "flat-ground-reference.obj"),
    geometryToObj(flatGeo, "flat_ground_reference")
  );

  const sphereGeo = new THREE.SphereGeometry(SPHERE_MOON_RADIUS, 180, 120);
  const pos = sphereGeo.getAttribute("position") as THREE.BufferAttribute;
  const tmp = new THREE.Vector3();
  for (let i = 0; i < pos.count; i += 1) {
    tmp.fromBufferAttribute(pos, i);
    const yn = THREE.MathUtils.clamp(tmp.y / SPHERE_MOON_RADIUS, -1, 1);
    const theta = Math.acos(yn);
    const phi = Math.atan2(tmp.z, tmp.x);
    const x = (phi / SPHERE_LAMBDA_MAX) * GROUND_HALF_EXTENT;
    const z = (((theta - SPHERE_THETA_MIN) / SPHERE_THETA_SPAN) * 2 - 1) * GROUND_HALF_EXTENT;
    const d = sphereCraterDisplacementMeters(x, z);
    tmp.normalize().multiplyScalar(SPHERE_MOON_RADIUS - d);
    pos.setXYZ(i, tmp.x, tmp.y, tmp.z);
  }
  pos.needsUpdate = true;
  sphereGeo.computeVertexNormals();
  await writeText(
    path.join(root, "exports", "models", "sphere-moon-reference.obj"),
    geometryToObj(sphereGeo, "sphere_moon_reference")
  );

  await downloadTexture(
    NASA_MOON_PREVIEW_JPG,
    path.join(root, "exports", "textures", "moon-nasa-preview.jpg")
  );

  await fs.mkdir(path.join(root, "exports", "textures"), { recursive: true });
  await fs.writeFile(
    path.join(root, "exports", "textures", "README.txt"),
    [
      "Moon texture sources:",
      `- NASA base texture URL: ${NASA_MOON_PREVIEW_JPG}`,
      "- Runtime fallback texture: generated procedurally in src/game/visual/sphereMoonVisual.ts (createStylizedMoonAlbedoTexture).",
      "- OBJ model references are in exports/models/ (flat-ground-reference.obj, sphere-moon-reference.obj).",
      "- If you generate a replacement texture, keep equirectangular 2:1 ratio (recommended 4096x2048)."
    ].join("\n") + "\n",
    "utf8"
  );

  console.log(`Exported mode references to: ${path.join(root, "exports")}`);
}

void main();

