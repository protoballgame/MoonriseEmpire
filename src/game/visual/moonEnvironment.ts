import * as THREE from "three";
import { WORLD_PLAY_SPAN_METERS } from "../../core/world/worldGrid";

/** Matches directional light in `main.ts` — sunward shading on regolith. */
export const MOON_SUN_DIRECTION_WORLD = new THREE.Vector3(0.45, 0.78, 0.42).normalize();

/** Clear color / scene.background — this is now the sky base, no finite dome mesh. */
export const MOON_CLEAR_COLOR = 0x1a2238;

function hash2(x: number, z: number): number {
  const s = Math.sin(x * 127.1 + z * 311.7) * 43758.5453123;
  return s - Math.floor(s);
}

function fbm2(x: number, z: number): number {
  let v = 0;
  let a = 0.5;
  let px = x;
  let pz = z;
  for (let i = 0; i < 5; i += 1) {
    const gx = Math.floor(px);
    const gz = Math.floor(pz);
    const fx = px - gx;
    const fz = pz - gz;
    const u = fx * fx * (3 - 2 * fx);
    const w = fz * fz * (3 - 2 * fz);
    const n00 = hash2(gx, gz);
    const n10 = hash2(gx + 1, gz);
    const n01 = hash2(gx, gz + 1);
    const n11 = hash2(gx + 1, gz + 1);
    const nx0 = n00 * (1 - u) + n10 * u;
    const nx1 = n01 * (1 - u) + n11 * u;
    v += a * (nx0 * (1 - w) + nx1 * w);
    px *= 2.02;
    pz *= 2.02;
    a *= 0.5;
  }
  return v;
}

/**
 * Tileable grey regolith + soft crater darkening (CPU once → GPU repeat).
 * Uses StandardMaterial so the ground still receives cast shadows.
 */
function createRegolithMapTexture(): THREE.CanvasTexture {
  const w = 256;
  const h = 256;
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d")!;
  const img = ctx.createImageData(w, h);
  const data = img.data;
  for (let j = 0; j < h; j += 1) {
    for (let i = 0; i < w; i += 1) {
      const u = i / w;
      const v = j / h;
      const x = u * 14;
      const z = v * 14;
      const h0 = fbm2(x, z);
      const fine = fbm2(x * 3.6, z * 3.6) * 0.12;
      const gx = Math.floor(x * 0.38);
      const gz = Math.floor(z * 0.38);
      const lx = (x * 0.38 - gx - 0.5) * 2;
      const lz = (z * 0.38 - gz - 0.5) * 2;
      const r = Math.hypot(lx, lz);
      const rim = Math.max(0, Math.min(1, (r - 0.38) / 0.12));
      const cellHash = hash2(gx + 19, gz + 41);
      const crater = (1 - rim) * (cellHash > 0.72 ? 0.55 : 0);

      let lum = 0.42 + h0 * 0.22 + fine - crater * 0.35;
      lum = Math.max(0.12, Math.min(1, lum));
      const rC = Math.floor(255 * lum * 0.96);
      const gC = Math.floor(255 * lum * 0.95);
      const bC = Math.floor(255 * lum * 0.99);
      const o = (j * w + i) * 4;
      data[o] = rC;
      data[o + 1] = gC;
      data[o + 2] = bC;
      data[o + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  const tex = new THREE.CanvasTexture(canvas);
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  return tex;
}

let regolithTextureCache: THREE.CanvasTexture | null = null;

function getRegolithTexture(): THREE.CanvasTexture {
  if (!regolithTextureCache) regolithTextureCache = createRegolithMapTexture();
  return regolithTextureCache;
}

/**
 * Flat playable plane (simulation stays at y = 0).
 */
export function createLunarRegolithGroundMesh(worldSpan: number = WORLD_PLAY_SPAN_METERS): THREE.Mesh {
  const geom = new THREE.PlaneGeometry(worldSpan, worldSpan, 1, 1);
  const map = getRegolithTexture();
  map.repeat.set(worldSpan * 0.065, worldSpan * 0.065);
  map.needsUpdate = true;
  const mat = new THREE.MeshStandardMaterial({
    map,
    roughness: 0.93,
    metalness: 0.02,
    envMapIntensity: 0
  });
  const mesh = new THREE.Mesh(geom, mat);
  mesh.rotation.x = -Math.PI / 2;
  mesh.receiveShadow = true;
  mesh.name = "lunarRegolithGround";
  return mesh;
}

function rng01(s: number): number {
  const x = Math.sin(s * 127.1) * 43758.5453;
  return x - Math.floor(x);
}

let starSoftSpriteTexture: THREE.CanvasTexture | null = null;

/** Soft round point sprite so stars read as discs instead of square GL_POINTS. */
function getStarSoftSpriteTexture(): THREE.CanvasTexture {
  if (starSoftSpriteTexture) return starSoftSpriteTexture;
  const c = document.createElement("canvas");
  c.width = 64;
  c.height = 64;
  const ctx = c.getContext("2d");
  if (!ctx) {
    starSoftSpriteTexture = new THREE.CanvasTexture(c);
    starSoftSpriteTexture.colorSpace = THREE.SRGBColorSpace;
    return starSoftSpriteTexture;
  }
  const g = ctx.createRadialGradient(32, 32, 0, 32, 32, 31.5);
  g.addColorStop(0, "rgba(255,255,255,1)");
  g.addColorStop(0.18, "rgba(255,255,255,0.45)");
  g.addColorStop(0.42, "rgba(220,235,255,0.12)");
  g.addColorStop(1, "rgba(0,0,0,0)");
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 64, 64);
  starSoftSpriteTexture = new THREE.CanvasTexture(c);
  starSoftSpriteTexture.colorSpace = THREE.SRGBColorSpace;
  starSoftSpriteTexture.wrapS = THREE.ClampToEdgeWrapping;
  starSoftSpriteTexture.wrapT = THREE.ClampToEdgeWrapping;
  starSoftSpriteTexture.needsUpdate = true;
  return starSoftSpriteTexture;
}

function addStarLayers(parent: THREE.Object3D): void {
  const starMap = getStarSoftSpriteTexture();
  const tmpDir = new THREE.Vector3();
  const milkyPlaneN = new THREE.Vector3(0.2, 0.93, 0.31).normalize();

  const makeLayer = (
    count: number,
    r0: number,
    r1: number,
    size: number,
    opacity: number,
    hueShift: number,
    opts?: {
      blending?: THREE.Blending;
      biasPlane?: THREE.Vector3;
      /** Keep stars with |dir·plane| below this (narrow band when < 1). */
      biasDotMax?: number;
    }
  ) => {
    const positions = new Float32Array(count * 3);
    const colors = new Float32Array(count * 3);
    let i = 0;
    let seed = 9.2 + hueShift * 17;
    const biasPlane = opts?.biasPlane;
    const biasDotMax = opts?.biasDotMax ?? 1;
    while (i < count) {
      seed += 1.63;
      const u = rng01(seed) * 2 - 1;
      const v = rng01(seed + 1.1) * 2 - 1;
      const w = rng01(seed + 2.3) * 2 - 1;
      const len = Math.sqrt(u * u + v * v + w * w);
      if (len < 1e-4) continue;
      tmpDir.set(u / len, w / len, v / len);
      if (biasPlane && Math.abs(tmpDir.dot(biasPlane)) > biasDotMax) continue;
      const R = r0 + rng01(seed + 4) * (r1 - r0);
      positions[i * 3] = tmpDir.x * R;
      positions[i * 3 + 1] = tmpDir.y * R;
      positions[i * 3 + 2] = tmpDir.z * R;
      const tw = 0.55 + rng01(seed + 5) * 0.45;
      const warm = rng01(seed + 9.1);
      const cool = 0.72 + hueShift * 0.1;
      const rC = (0.88 + rng01(seed + 6) * 0.14 + warm * 0.08) * tw * cool;
      const gC = (0.86 + rng01(seed + 7) * 0.12) * tw;
      const bC = (0.96 + rng01(seed + 8) * 0.08 + (1 - warm) * 0.06) * tw;
      colors[i * 3] = rC;
      colors[i * 3 + 1] = gC;
      colors[i * 3 + 2] = bC;
      i += 1;
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.BufferAttribute(positions, 3));
    geo.setAttribute("color", new THREE.BufferAttribute(colors, 3));
    const mat = new THREE.PointsMaterial({
      map: starMap,
      size,
      sizeAttenuation: true,
      vertexColors: true,
      transparent: true,
      opacity,
      depthWrite: false,
      fog: false,
      blending: opts?.blending ?? THREE.NormalBlending,
      alphaTest: 0.02
    });
    const pts = new THREE.Points(geo, mat);
    pts.frustumCulled = false;
    parent.add(pts);
  };

  makeLayer(5200, 172, 252, 1.35, 0.82, 0);
  makeLayer(2600, 160, 246, 2.05, 0.52, 0.22, {
    biasPlane: milkyPlaneN,
    biasDotMax: 0.38
  });
  makeLayer(720, 154, 198, 3.2, 0.95, 0.55, { blending: THREE.AdditiveBlending });
}

function addSpaceSkySphere(parent: THREE.Object3D): THREE.Mesh {
  const geo = new THREE.SphereGeometry(1200, 56, 36);
  // Deterministic always-lit dome to avoid any directional bands/hemisphere artifacts.
  const mat = new THREE.MeshBasicMaterial({
    color: 0x1a2238,
    side: THREE.BackSide,
    depthWrite: false,
    fog: false
  });
  const sky = new THREE.Mesh(geo, mat);
  sky.name = "moonSpaceSkySphere";
  // Draw first; gameplay fog is applied to the moon material, never over this sky dome.
  sky.renderOrder = -1;
  parent.add(sky);
  return sky;
}

/** Distant silhouettes / beacons / line constellations for orientation (spins with moon). */
function addSkyLandmarks(parent: THREE.Object3D): void {
  const g = new THREE.Group();
  g.name = "moonSpaceLandmarks";

  const lineMat = (hex: number, opacity: number) =>
    new THREE.LineBasicMaterial({
      color: hex,
      transparent: true,
      opacity,
      depthWrite: false,
      fog: false
    });

  const addConstellation = (dirs: THREE.Vector3[], radius: number, color: number, opacity: number): void => {
    if (dirs.length < 2) return;
    const verts: number[] = [];
    for (let i = 0; i < dirs.length - 1; i += 1) {
      const a = dirs[i]!.clone().multiplyScalar(radius);
      const b = dirs[i + 1]!.clone().multiplyScalar(radius);
      verts.push(a.x, a.y, a.z, b.x, b.y, b.z);
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.Float32BufferAttribute(verts, 3));
    const line = new THREE.LineSegments(geo, lineMat(color, opacity));
    line.frustumCulled = false;
    g.add(line);
  };

  const beacon = (dir: THREE.Vector3, color: number, r: number, s: number): void => {
    const mesh = new THREE.Mesh(
      new THREE.SphereGeometry(s, 10, 8),
      new THREE.MeshBasicMaterial({
        color,
        transparent: true,
        opacity: 0.94,
        depthWrite: false,
        fog: false
      })
    );
    mesh.position.copy(dir.clone().normalize().multiplyScalar(r));
    mesh.frustumCulled = false;
    g.add(mesh);
  };

  const makeZodiacGlyphTexture = (glyph: string, color: number): THREE.CanvasTexture => {
    const canvas = document.createElement("canvas");
    canvas.width = 128;
    canvas.height = 128;
    const ctx = canvas.getContext("2d");
    if (ctx) {
      ctx.clearRect(0, 0, 128, 128);
      const col = new THREE.Color(color);
      const css = `rgb(${Math.round(col.r * 255)}, ${Math.round(col.g * 255)}, ${Math.round(col.b * 255)})`;
      ctx.shadowColor = css;
      ctx.shadowBlur = 16;
      ctx.fillStyle = "rgba(10, 16, 32, 0.56)";
      ctx.beginPath();
      ctx.arc(64, 64, 45, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = css;
      ctx.lineWidth = 4;
      ctx.beginPath();
      ctx.arc(64, 64, 45, 0, Math.PI * 2);
      ctx.stroke();
      ctx.shadowBlur = 10;
      ctx.fillStyle = css;
      ctx.font = "78px 'Segoe UI Symbol', 'Noto Sans Symbols', 'Arial Unicode MS', sans-serif";
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText(glyph, 64, 68);
    }
    const tex = new THREE.CanvasTexture(canvas);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.needsUpdate = true;
    return tex;
  };

  const addZodiacGlyph = (dir: THREE.Vector3, glyph: string, color: number): void => {
    const sprite = new THREE.Sprite(
      new THREE.SpriteMaterial({
        map: makeZodiacGlyphTexture(glyph, color),
        transparent: true,
        depthWrite: false,
        fog: false,
        toneMapped: false
      })
    );
    sprite.name = `zodiacGlyph-${glyph}`;
    sprite.position.copy(dir.clone().normalize().multiplyScalar(286));
    sprite.scale.setScalar(9.2);
    sprite.frustumCulled = false;
    g.add(sprite);
  };

  const R = 266;
  beacon(new THREE.Vector3(0.62, 0.48, -0.62), 0xff6a9a, R, 1.15);
  beacon(new THREE.Vector3(-0.78, 0.22, 0.58), 0x66f0ff, R, 0.95);
  beacon(new THREE.Vector3(0.15, -0.88, 0.45), 0xffcc66, R, 1.05);
  beacon(new THREE.Vector3(-0.35, 0.72, -0.6), 0xa8ff88, R, 0.88);
  beacon(new THREE.Vector3(0.91, -0.12, -0.4), 0xc4a8ff, R, 0.72);
  beacon(new THREE.Vector3(-0.55, -0.65, 0.52), 0xff8866, R, 0.78);
  beacon(new THREE.Vector3(0.3, -0.82, -0.48), 0x66aaff, R, 0.9);
  beacon(new THREE.Vector3(-0.1, -0.96, -0.24), 0xe8ff88, R, 0.62);
  beacon(new THREE.Vector3(-0.82, -0.38, -0.42), 0xff66d0, R, 0.84);

  const station = new THREE.Group();
  const stDir = new THREE.Vector3(-0.42, 0.55, 0.72).normalize();
  station.position.copy(stDir.clone().multiplyScalar(258));
  station.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), stDir.clone().negate());
  const ring = new THREE.Mesh(
    new THREE.TorusGeometry(4.2, 0.28, 10, 56),
    new THREE.MeshBasicMaterial({
      color: 0x9aaccc,
      transparent: true,
      opacity: 0.5,
      depthWrite: false,
      fog: false
    })
  );
  ring.rotation.x = Math.PI / 2;
  station.add(ring);
  const hub = new THREE.Mesh(
    new THREE.BoxGeometry(1.8, 0.45, 1.8),
    new THREE.MeshBasicMaterial({
      color: 0x8899b8,
      transparent: true,
      opacity: 0.55,
      depthWrite: false,
      fog: false
    })
  );
  station.add(hub);
  g.add(station);

  const arcAxis = new THREE.Vector3(0.25, 0.85, 0.46).normalize();
  const arcPerp = new THREE.Vector3(0.92, -0.28, -0.26).normalize();
  for (let k = 0; k < 11; k += 1) {
    const t = (k / 10) * Math.PI * 0.42;
    const dir = arcAxis
      .clone()
      .multiplyScalar(Math.cos(t) * 0.18)
      .add(arcPerp.clone().multiplyScalar(Math.sin(t) * 0.18))
      .normalize();
    beacon(dir, 0xff4466, 267, 0.36);
  }

  const d1 = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z).normalize();
  addConstellation(
    [
      d1(0.5, 0.55, 0.66),
      d1(0.42, 0.62, 0.66),
      d1(0.34, 0.58, 0.7),
      d1(0.28, 0.48, 0.78),
      d1(0.22, 0.4, 0.82)
    ],
    264,
    0x88aacc,
    0.38
  );
  addConstellation(
    [
      d1(-0.7, 0.35, 0.62),
      d1(-0.62, 0.42, 0.64),
      d1(-0.55, 0.38, 0.72),
      d1(-0.48, 0.28, 0.78)
    ],
    265,
    0xaa88cc,
    0.32
  );
  addConstellation(
    [
      d1(0.2, -0.55, 0.78),
      d1(0.28, -0.48, 0.76),
      d1(0.38, -0.42, 0.74),
      d1(0.48, -0.35, 0.7),
      d1(0.55, -0.28, 0.66)
    ],
    263,
    0x66bbaa,
    0.28
  );
  addConstellation(
    [
      d1(-0.15, -0.72, -0.68),
      d1(-0.28, -0.62, -0.73),
      d1(-0.42, -0.5, -0.76),
      d1(-0.55, -0.42, -0.71),
      d1(-0.66, -0.32, -0.66)
    ],
    264,
    0xdd99ff,
    0.34
  );
  addConstellation(
    [
      d1(0.76, -0.34, -0.55),
      d1(0.68, -0.45, -0.58),
      d1(0.58, -0.56, -0.6),
      d1(0.46, -0.68, -0.56)
    ],
    266,
    0x99ccff,
    0.3
  );

  // Zodiac ring: 12 simplified constellations split into equal ecliptic sectors.
  // These are navigation landmarks, not an astronomy atlas; order and rough silhouettes follow the real zodiac.
  const eclipticNorth = new THREE.Vector3(0.12, 0.92, 0.38).normalize();
  const eclipticX = new THREE.Vector3(1, 0.02, -0.08);
  eclipticX.addScaledVector(eclipticNorth, -eclipticX.dot(eclipticNorth)).normalize();
  const eclipticY = new THREE.Vector3().crossVectors(eclipticNorth, eclipticX).normalize();
  const eclipticDir = (lonDeg: number, latDeg = 0): THREE.Vector3 => {
    const lon = THREE.MathUtils.degToRad(lonDeg);
    const lat = THREE.MathUtils.degToRad(latDeg);
    const cl = Math.cos(lat);
    return eclipticX
      .clone()
      .multiplyScalar(Math.cos(lon) * cl)
      .addScaledVector(eclipticY, Math.sin(lon) * cl)
      .addScaledVector(eclipticNorth, Math.sin(lat))
      .normalize();
  };
  const zodiacColor = [
    0xffc266,
    0xffdd88,
    0x88ccff,
    0xa8e8ff,
    0xffaa55,
    0xaaffaa,
    0xddccff,
    0xff6688,
    0xff9966,
    0xb8e0ff,
    0x88f0ff,
    0xbbaaff
  ];
  const zodiacPatterns: { name: string; glyph: string; pts: [number, number][] }[] = [
    { name: "Aries", glyph: "♈", pts: [[-10, -2], [-5, 4], [0, 0], [6, 5], [11, -1]] },
    { name: "Taurus", glyph: "♉", pts: [[-12, -2], [-6, 2], [0, 0], [6, 3], [12, -3], [3, 1], [7, 9], [3, 1], [0, -7]] },
    { name: "Gemini", glyph: "♊", pts: [[-10, 6], [-4, 7], [2, 5], [8, 7], [2, 5], [2, -5], [8, -7], [2, -5], [-4, -7], [-10, -6], [-4, -7], [-4, 7]] },
    { name: "Cancer", glyph: "♋", pts: [[-9, 1], [-4, 5], [1, 2], [5, 5], [9, 1], [3, -3], [-3, -5], [-8, -2]] },
    { name: "Leo", glyph: "♌", pts: [[-12, -4], [-6, -2], [0, -3], [6, 0], [10, 5], [5, 9], [0, 5], [4, 1], [10, 5]] },
    { name: "Virgo", glyph: "♍", pts: [[-12, 2], [-7, -2], [-2, 1], [3, -3], [8, -1], [12, -5], [7, 4], [1, 6], [-4, 3], [-10, 6]] },
    { name: "Libra", glyph: "♎", pts: [[-11, -3], [-6, 2], [0, 5], [6, 2], [11, -3], [5, -4], [-5, -4], [-11, -3]] },
    { name: "Scorpio", glyph: "♏", pts: [[-13, 4], [-8, 2], [-3, 3], [2, 0], [7, -2], [12, -1], [9, -6], [13, -8]] },
    { name: "Sagittarius", glyph: "♐", pts: [[-10, -5], [-3, 0], [4, 5], [10, 8], [4, 5], [8, -2], [2, 2], [-4, 6], [2, 2], [-8, -2]] },
    { name: "Capricorn", glyph: "♑", pts: [[-12, 2], [-7, -3], [-1, -5], [5, -2], [10, 3], [6, 7], [0, 4], [-5, 6], [-10, 4]] },
    { name: "Aquarius", glyph: "♒", pts: [[-12, 3], [-7, 6], [-2, 3], [3, 6], [8, 3], [12, 6], [9, -3], [4, 0], [-1, -3], [-6, 0], [-11, -3]] },
    { name: "Pisces", glyph: "♓", pts: [[-11, 5], [-6, 8], [-1, 5], [4, 2], [10, 5], [12, 0], [7, -4], [1, -2], [-5, -6], [-11, -4], [-5, -6], [-1, 5]] }
  ];
  for (let i = 0; i < zodiacPatterns.length; i += 1) {
    const sectorLon = i * 30 + 15;
    const color = zodiacColor[i]!;
    const z = zodiacPatterns[i]!;
    const dirs = z.pts.map(([lonOff, lat]) => eclipticDir(sectorLon + lonOff, lat));
    addConstellation(dirs, 282, color, 0.5);
    beacon(eclipticDir(sectorLon, 0), color, 284, i % 3 === 0 ? 0.62 : 0.46);
    addZodiacGlyph(eclipticDir(sectorLon, 16), z.glyph, color);
    // Faint sector divider at each sign boundary.
    addConstellation([eclipticDir(i * 30, -11), eclipticDir(i * 30, 11)], 281, 0x5f6f94, 0.16);
  }

  parent.add(g);
}

function addStylizedBody(
  parent: THREE.Object3D,
  radius: number,
  color: number,
  emissive: number,
  emissiveIntensity: number,
  roughness: number
): THREE.Mesh {
  const geo = new THREE.SphereGeometry(radius, 22, 18);
  const mat = new THREE.MeshStandardMaterial({
    color,
    emissive,
    emissiveIntensity,
    roughness,
    metalness: 0.06,
    fog: false
  });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.castShadow = false;
  mesh.receiveShadow = false;
  parent.add(mesh);
  return mesh;
}

/** Distant semi-accurate solar system lineup — parented with sky so map spin stays coherent. */
function addCelestialWayfinding(parent: THREE.Object3D): THREE.Group {
  const g = new THREE.Group();
  g.name = "moonCelestialWayfinding";

  const eclipticNorth = new THREE.Vector3(0.12, 0.92, 0.38).normalize();
  const eclipticX = MOON_SUN_DIRECTION_WORLD.clone();
  eclipticX.addScaledVector(eclipticNorth, -eclipticX.dot(eclipticNorth)).normalize();
  const eclipticY = new THREE.Vector3().crossVectors(eclipticNorth, eclipticX).normalize();
  const eclipticDir = (lonDeg: number, latDeg = 0): THREE.Vector3 => {
    const lon = THREE.MathUtils.degToRad(lonDeg);
    const lat = THREE.MathUtils.degToRad(latDeg);
    const cl = Math.cos(lat);
    return eclipticX
      .clone()
      .multiplyScalar(Math.cos(lon) * cl)
      .addScaledVector(eclipticY, Math.sin(lon) * cl)
      .addScaledVector(eclipticNorth, Math.sin(lat))
      .normalize();
  };

  const addAtEcliptic = (
    name: string,
    lonDeg: number,
    latDeg: number,
    distance: number,
    radius: number,
    color: number,
    emissive: number,
    emissiveIntensity: number,
    roughness = 0.9
  ): THREE.Group => {
    const group = new THREE.Group();
    group.name = `solarSystem-${name}`;
    group.position.copy(eclipticDir(lonDeg, latDeg).multiplyScalar(distance));
    addStylizedBody(group, radius, color, emissive, emissiveIntensity, roughness);
    g.add(group);
    return group;
  };

  const sunGroup = new THREE.Group();
  sunGroup.name = "solarSystem-Sun";
  sunGroup.position.copy(eclipticDir(0, 0)).multiplyScalar(258);
  const sunCore = addStylizedBody(sunGroup, 11, 0xffe8a8, 0xffaa44, 1.35, 0.35);
  sunCore.scale.setScalar(1);
  const sunHaloGeo = new THREE.SphereGeometry(16, 20, 16);
  const sunHaloMat = new THREE.MeshBasicMaterial({
    color: 0xffdcb0,
    transparent: true,
    opacity: 0.22,
    depthWrite: false,
    fog: false
  });
  const sunHalo = new THREE.Mesh(sunHaloGeo, sunHaloMat);
  sunGroup.add(sunHalo);
  g.add(sunGroup);

  // Ordered from the Sun outward. Sizes are compressed for readability but preserve the rough ranking.
  const mercury = addAtEcliptic("Mercury", 17, -3, 236, 2.35, 0x9b9486, 0x25211c, 0.18);
  mercury.scale.set(1.04, 0.98, 1);

  addAtEcliptic("Venus", 34, 1, 239, 4.75, 0xf0e8b8, 0xc8b060, 0.28);

  const earth = addAtEcliptic("Earth", 52, -1, 242, 5.1, 0x4a8fd4, 0x1a5088, 0.42, 0.88);
  const land = addStylizedBody(earth, 7.25, 0x3d7a4a, 0x0a2810, 0.15, 0.95);
  land.scale.set(0.72, 0.16, 0.72);
  land.rotation.y = 0.7;

  addAtEcliptic("Mars", 72, 2, 246, 3.35, 0xc45c3a, 0x5c1808, 0.32, 0.92);

  const jupiter = addAtEcliptic("Jupiter", 106, -1, 250, 8.7, 0xc4a882, 0x4a3018, 0.12, 0.9);
  const jBody = addStylizedBody(jupiter, 9, 0xc4a882, 0x4a3018, 0.12, 0.9);
  jBody.scale.set(1.12, 1, 1.08);
  const jStripe = addStylizedBody(jupiter, 9.05, 0x8a6040, 0x2a1008, 0.08, 0.94);
  jStripe.scale.set(1.14, 0.22, 1.1);

  const saturn = addAtEcliptic("Saturn", 142, 1, 253, 7.7, 0xe8d8b0, 0x6a5840, 0.14, 0.9);
  saturn.rotation.z = 0.22;
  saturn.rotation.x = 0.18;
  const ring = new THREE.Mesh(
    new THREE.RingGeometry(10, 16.5, 56),
    new THREE.MeshBasicMaterial({
      color: 0xd8c8a8,
      transparent: true,
      opacity: 0.55,
      side: THREE.DoubleSide,
      depthWrite: false,
      fog: false
    })
  );
  ring.rotation.x = Math.PI / 2;
  saturn.add(ring);

  const uranus = addAtEcliptic("Uranus", 176, -2, 249, 5.9, 0x8fe8df, 0x164c54, 0.24);
  uranus.rotation.z = Math.PI * 0.48;
  const uranusRing = new THREE.Mesh(
    new THREE.RingGeometry(7.0, 9.6, 44),
    new THREE.MeshBasicMaterial({
      color: 0xb8fff2,
      transparent: true,
      opacity: 0.24,
      side: THREE.DoubleSide,
      depthWrite: false,
      fog: false
    })
  );
  uranusRing.rotation.x = Math.PI / 2;
  uranus.add(uranusRing);

  addAtEcliptic("Neptune", 210, 1, 246, 5.7, 0x4c6fd8, 0x12204c, 0.3);

  parent.add(g);
  return g;
}

/**
 * No atmospheric fog (vacuum). Gradient sky with nebula, layered stars, and cute distant planets.
 */
export function setupMoonAtmosphere(
  scene: THREE.Scene,
  renderer: THREE.WebGLRenderer,
  opts?: { voidOnly?: boolean }
): void {
  const voidOnly = opts?.voidOnly === true;
  renderer.setClearColor(MOON_CLEAR_COLOR, 1);
  scene.background = new THREE.Color(MOON_CLEAR_COLOR);
  scene.fog = null;
  const cosmos = new THREE.Group();
  cosmos.name = "moonSpaceCosmos";
  scene.add(cosmos);
  addSpaceSkySphere(cosmos);
  addStarLayers(cosmos);
  addSkyLandmarks(cosmos);
  if (!voidOnly) addCelestialWayfinding(cosmos);
}
