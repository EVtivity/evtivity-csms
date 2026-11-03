// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

// Merges the fixed parts of many station models into few meshes.

import * as THREE from 'three';

import type { SceneCtx } from './site-layout-scene-context';

/** From this many stations, the fixed parts of the station models are merged (outside Edit Layout). */
export const MERGE_STATIONS_FROM = 60;

export function mergesStations(stationCount: number): boolean {
  return stationCount >= MERGE_STATIONS_FROM;
}

/**
 * A copy of a geometry as plain triangles with a position, a normal and a uv
 * each (uv 0 where it had none), ready to concatenate; null for a geometry
 * that is not triangles with positions.
 */
export function flatGeometry(source: THREE.BufferGeometry): THREE.BufferGeometry | null {
  if (!source.hasAttribute('position')) return null;
  const g = source.index != null ? source.toNonIndexed() : source.clone();
  for (const name of Object.keys(g.attributes)) {
    if (name !== 'position' && name !== 'normal' && name !== 'uv') g.deleteAttribute(name);
  }
  if (!g.hasAttribute('normal')) g.computeVertexNormals();
  if (!g.hasAttribute('uv')) {
    const count = g.getAttribute('position').count;
    g.setAttribute('uv', new THREE.Float32BufferAttribute(new Float32Array(count * 2), 2));
  }
  g.clearGroups();
  return g;
}

/** One geometry from plain triangle geometries (flatGeometry). */
export function concatGeometries(parts: readonly THREE.BufferGeometry[]): THREE.BufferGeometry {
  const names = ['position', 'normal', 'uv'] as const;
  const out = new THREE.BufferGeometry();
  for (const name of names) {
    const size = name === 'uv' ? 2 : 3;
    const total = parts.reduce((n, p) => n + p.getAttribute(name).count * size, 0);
    const data = new Float32Array(total);
    let offset = 0;
    for (const p of parts) {
      const attr = p.getAttribute(name);
      for (let i = 0; i < attr.count; i++) {
        data[offset++] = attr.getX(i);
        data[offset++] = attr.getY(i);
        if (size === 3) data[offset++] = attr.getZ(i);
      }
    }
    out.setAttribute(name, new THREE.Float32BufferAttribute(data, size));
  }
  out.computeBoundingSphere();
  return out;
}

export function installMerge(scn: SceneCtx): void {
  // What makes two materials draw the same: merged meshes share the first one.
  function materialKey(m: THREE.Material): string {
    // Only standard materials carry these; a basic material leaves them out.
    const std = m as Partial<
      Pick<
        THREE.MeshStandardMaterial,
        'color' | 'emissive' | 'emissiveIntensity' | 'roughness' | 'metalness' | 'map'
      >
    >;
    return [
      m.type,
      std.color?.getHexString() ?? '',
      std.emissive?.getHexString() ?? '',
      String(std.emissiveIntensity ?? ''),
      String(std.roughness ?? ''),
      String(std.metalness ?? ''),
      std.map?.uuid ?? '',
      String(m.transparent),
      String(m.opacity),
      String(m.side),
      String(m.depthWrite),
      String(m.blending),
      String(m.polygonOffset),
    ].join('|');
  }

  // Merges the fixed parts of every station model into one mesh per look,
  // so a site of 200 stations takes a few dozen draw calls instead of
  // thousands. A pulsing or blinking status light, the charging glow,
  // the selection ring and every additive halo stay separate (they animate or
  // change). Each station keeps an invisible box to pick it by; its group
  // stays where it was, so labels and the popup still follow it.
  function mergeStations(): void {
    scn.site.updateMatrixWorld(true);
    const siteInverse = new THREE.Matrix4().copy(scn.site.matrixWorld).invert();
    const buckets = new Map<
      string,
      { material: THREE.Material; parts: THREE.BufferGeometry[]; cast: boolean }
    >();
    const hitMaterial = scn.track(new THREE.MeshBasicMaterial({ visible: false }));
    for (const [id, obj] of scn.objects) {
      // A steady status light merges too; a pulsing one (charging) animates.
      const keep = new Set<THREE.Material>([obj.ring.material]);
      if (obj.station.pulsing || obj.station.blinking) keep.add(obj.light);
      if (obj.glow != null) keep.add(obj.glow.strip).add(obj.glow.halo);
      const groupInverse = new THREE.Matrix4().copy(obj.group.matrixWorld).invert();
      const bounds = new THREE.Box3();
      const merged: THREE.Object3D[] = [];
      obj.group.traverse((o) => {
        if (!(o instanceof THREE.Mesh)) return;
        const material = o.material as THREE.Material | THREE.Material[];
        if (Array.isArray(material) || keep.has(material)) return;
        if (material.blending === THREE.AdditiveBlending || o.userData['ring'] === true) return;
        // The rotation handle shows only in Edit Layout, where stations are not merged.
        if (o.userData['rotateHandle'] != null) return;
        const part = flatGeometry(o.geometry as THREE.BufferGeometry);
        if (part == null) return;
        part.computeBoundingBox();
        if (part.boundingBox != null) {
          bounds.union(
            part.boundingBox.clone().applyMatrix4(groupInverse.clone().multiply(o.matrixWorld)),
          );
        }
        part.applyMatrix4(siteInverse.clone().multiply(o.matrixWorld));
        const key = materialKey(material);
        const bucket = buckets.get(key) ?? { material, parts: [], cast: false };
        bucket.parts.push(part);
        bucket.cast ||= o.castShadow;
        buckets.set(key, bucket);
        merged.push(o);
      });
      for (const o of merged) o.removeFromParent();
      if (!bounds.isEmpty()) {
        const size = bounds.getSize(new THREE.Vector3());
        const center = bounds.getCenter(new THREE.Vector3());
        const hit = new THREE.Mesh(
          scn.track(new THREE.BoxGeometry(size.x, size.y, size.z)),
          hitMaterial,
        );
        hit.position.copy(center);
        hit.userData['stationId'] = id;
        obj.group.add(hit);
      }
    }
    for (const bucket of buckets.values()) {
      const geometry = scn.track(concatGeometries(bucket.parts));
      for (const part of bucket.parts) part.dispose();
      const mesh = new THREE.Mesh(geometry, bucket.material);
      mesh.castShadow = bucket.cast;
      mesh.receiveShadow = true;
      mesh.raycast = () => undefined;
      scn.site.add(mesh);
    }
  }
  scn.mergeStations = mergeStations;
}
