import * as THREE from "three";
import {
  flatXZToSphereNormal,
  flatXZToSphereSurfaceDisplaced,
  SPHERE_MOON_RADIUS,
  sphereCraterDisplacementMeters,
  sphereCraterStamps,
  sphereSurfacePointToFlatXZ
} from "../../core/world/sphereTerrain";

function createStylizedMoonAlbedoTexture(): THREE.CanvasTexture {
  const w = 2048;
  const h = 1024;
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d");
  if (!ctx) {
    const tex = new THREE.CanvasTexture(canvas);
    tex.colorSpace = THREE.SRGBColorSpace;
    return tex;
  }

  const img = ctx.createImageData(w, h);
  const px = img.data;
  for (let y = 0; y < h; y += 1) {
    const v = y / (h - 1);
    const lat = (v - 0.5) * Math.PI;
    for (let x = 0; x < w; x += 1) {
      const u = x / (w - 1);
      const lon = (u - 0.5) * Math.PI * 2;

      // Large-scale tonal variation + maria-like bands.
      const n1 = Math.sin(lon * 2.1 + Math.cos(lat * 3.4) * 1.7) * 0.5 + 0.5;
      const n2 = Math.sin(lon * 9.2 - lat * 7.1) * 0.5 + 0.5;
      const n3 = Math.sin(lon * 21.0 + lat * 17.0) * Math.sin(lon * 13.0 - lat * 19.0) * 0.5 + 0.5;
      const mariaA = Math.max(0, Math.sin((lat + 0.22) * 6.3 + Math.sin(lon * 2.0)) * 0.5 + 0.5);
      const mariaB = Math.max(0, Math.cos(lon * 3.6 - lat * 2.8) * 0.5 + 0.5);
      const maria = Math.pow(mariaA * mariaB, 1.55);
      const craterSeed = Math.sin(lon * 47.0 + lat * 31.0) * Math.cos(lon * 29.0 - lat * 43.0);
      const craterFleck = Math.max(0, craterSeed - 0.78) * 0.22;
      const highlandFleck = Math.max(0, n3 - 0.74) * 0.16;
      const tone = 0.82 + (n1 - 0.5) * 0.26 + (n2 - 0.5) * 0.12 + highlandFleck - maria * 0.2 - craterFleck;

      const i = (y * w + x) * 4;
      px[i] = Math.max(0, Math.min(255, Math.round(218 * tone)));
      px[i + 1] = Math.max(0, Math.min(255, Math.round(208 * tone)));
      px[i + 2] = Math.max(0, Math.min(255, Math.round(232 * tone)));
      px[i + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);

  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.generateMipmaps = true;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.anisotropy = 8;
  tex.needsUpdate = true;
  return tex;
}

function createSeamFixedCanvasTexture(source: CanvasImageSource, width: number, height: number): THREE.CanvasTexture | null {
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;
  ctx.drawImage(source, 0, 0, width, height);
  const left = ctx.getImageData(0, 0, 1, height);
  const right = ctx.getImageData(width - 1, 0, 1, height);
  for (let i = 0; i < left.data.length; i += 4) {
    const r = Math.round((left.data[i] + right.data[i]) * 0.5);
    const g = Math.round((left.data[i + 1] + right.data[i + 1]) * 0.5);
    const b = Math.round((left.data[i + 2] + right.data[i + 2]) * 0.5);
    const a = Math.round((left.data[i + 3] + right.data[i + 3]) * 0.5);
    left.data[i] = r;
    left.data[i + 1] = g;
    left.data[i + 2] = b;
    left.data[i + 3] = a;
    right.data[i] = r;
    right.data[i + 1] = g;
    right.data[i + 2] = b;
    right.data[i + 3] = a;
  }
  ctx.putImageData(left, 0, 0);
  ctx.putImageData(right, width - 1, 0);
  return new THREE.CanvasTexture(canvas);
}

function seamFixedTexture(tex: THREE.Texture): THREE.Texture {
  const img = tex.image as
    | (CanvasImageSource & { width?: number; height?: number; videoWidth?: number; videoHeight?: number })
    | undefined;
  if (!img) return tex;
  const width = img.width ?? img.videoWidth ?? 0;
  const height = img.height ?? img.videoHeight ?? 0;
  if (!Number.isFinite(width) || !Number.isFinite(height) || width < 2 || height < 2) return tex;
  const fixed = createSeamFixedCanvasTexture(img, Math.round(width), Math.round(height));
  if (!fixed) return tex;
  tex.dispose();
  return fixed;
}

function applyTextureToSphereMaterial(mat: THREE.MeshStandardMaterial, tex: THREE.Texture): void {
  tex = seamFixedTexture(tex);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.generateMipmaps = true;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.anisotropy = 16;
  const prevMap = mat.map;
  mat.map = tex;
  if (prevMap && prevMap !== tex) prevMap.dispose();
  mat.needsUpdate = true;
}

/**
 * Low-poly displaced icosphere; crater depth uses the same field as sim impassable zones.
 */
export function createSphereMoonMesh(opts?: {
  moonModelUrl?: string;
  moonTextureUrl?: string;
  moonModelScale?: number;
}): THREE.Object3D {
  const root = new THREE.Group();
  root.name = "moonSphereRoot";
  const debugState: Record<string, unknown> = {
    moonModelUrl: opts?.moonModelUrl ?? null,
    moonTextureUrl: opts?.moonTextureUrl ?? null,
    customModelLoaded: false,
    customModelError: null,
    customModelMeshCount: 0,
    customModelUvMeshCount: 0,
    craterCount: sphereCraterStamps().length
  };

  const geo = new THREE.SphereGeometry(SPHERE_MOON_RADIUS, 112, 72);
  const pos = geo.attributes.position as THREE.BufferAttribute;
  const tmp = new THREE.Vector3();
  for (let i = 0; i < pos.count; i += 1) {
    tmp.fromBufferAttribute(pos, i);
    const flat = sphereSurfacePointToFlatXZ(tmp);
    const d = sphereCraterDisplacementMeters(flat.x, flat.z);
    tmp.normalize().multiplyScalar(SPHERE_MOON_RADIUS - d);
    pos.setXYZ(i, tmp.x, tmp.y, tmp.z);
  }
  pos.needsUpdate = true;
  geo.computeVertexNormals();

  const map = createStylizedMoonAlbedoTexture();
  const mat = new THREE.MeshStandardMaterial({
    color: 0xfff8f2,
    map,
    emissive: 0x30283a,
    emissiveIntensity: 0.26,
    roughness: 0.88,
    metalness: 0.02,
    envMapIntensity: 0,
    flatShading: false
  });

  const mesh = new THREE.Mesh(geo, mat);
  mesh.name = "moonSphereSurface";
  mesh.receiveShadow = true;
  mesh.castShadow = false;
  const craterGroup = createSphereCraterMeshes();
  craterGroup.name = "moonCraterStamps";
  root.add(craterGroup);
  root.add(mesh);

  const moonTextureUrl = opts?.moonTextureUrl?.trim();
  if (moonTextureUrl) {
    new THREE.TextureLoader().load(
      moonTextureUrl,
      (customTex) => {
        applyTextureToSphereMaterial(mat, customTex);
        debugState["customTextureLoaded"] = true;
        debugState["customTextureError"] = null;
        (window as unknown as { __moonDebug?: Record<string, unknown> }).__moonDebug = debugState;
      },
      undefined,
      (err) => {
        debugState["customTextureLoaded"] = false;
        debugState["customTextureError"] = String(err);
        console.warn("[moon-surface] Failed to load custom moon texture:", moonTextureUrl, err);
        (window as unknown as { __moonDebug?: Record<string, unknown> }).__moonDebug = debugState;
      }
    );
  }

  const moonModelUrl = opts?.moonModelUrl?.trim();
  if (moonModelUrl) {
    // Imported moon meshes proved less stable than the generated gameplay sphere:
    // they added visible seams/cracks and cost startup time even when hidden.
    debugState["customModelLoaded"] = false;
    debugState["customModelError"] = "skipped_for_stability";
  }
  (window as unknown as { __moonDebug?: Record<string, unknown> }).__moonDebug = debugState;

  return root;
}

function createSphereCraterMeshes(): THREE.Group {
  const group = new THREE.Group();
  group.name = "moonCraterStamps";
  const stamps = sphereCraterStamps();
  for (const c of stamps) {
    const center = flatXZToSphereSurfaceDisplaced(c.x, c.z);
    const n = flatXZToSphereNormal(c.x, c.z);
    const tangQ = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), n);

    const rimR = c.radius * 0.92;
    const rim = new THREE.Mesh(
      new THREE.TorusGeometry(rimR, Math.max(0.06, rimR * 0.12), 8, 28),
      new THREE.MeshStandardMaterial({
        color: 0xa6a9ae,
        roughness: 0.94,
        metalness: 0.02,
        emissive: 0x0d1014,
        emissiveIntensity: 0.18
      })
    );
    rim.position.copy(center).addScaledVector(n, 0.02);
    rim.quaternion.copy(tangQ).multiply(new THREE.Quaternion().setFromEuler(new THREE.Euler(Math.PI / 2, 0, 0)));
    rim.castShadow = false;
    rim.receiveShadow = true;
    group.add(rim);

    const basin = new THREE.Mesh(
      new THREE.CircleGeometry(c.radius * 0.8, 22),
      new THREE.MeshStandardMaterial({
        color: 0x6c7077,
        roughness: 0.98,
        metalness: 0.01,
        emissive: 0x06080c,
        emissiveIntensity: 0.12
      })
    );
    basin.position.copy(center).addScaledVector(n, 0.012);
    basin.quaternion
      .copy(tangQ)
      .multiply(new THREE.Quaternion().setFromEuler(new THREE.Euler(-Math.PI / 2, 0, 0)));
    basin.castShadow = false;
    basin.receiveShadow = true;
    group.add(basin);
  }
  return group;
}
