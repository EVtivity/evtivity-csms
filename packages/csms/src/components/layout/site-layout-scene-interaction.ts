// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

// Picking, hovering and dragging in the 3D site scene.

import { type FreePlacement } from '@evtivity/lib/site-layout';
import * as THREE from 'three';
import {
  bayTurn,
  clampToLot,
  handleRotation,
  worldToBay as lotToBay,
  type Point,
} from './site-layout-grid';

import type { SceneCtx } from './site-layout-scene-context';
import { pickChargerScreen } from './site-layout-scene-screen-text';
import { type PickKind, type StationObject } from './site-layout-scene-types';

/** The distance from `p` to the segment from `a` to `b`, on the ground. */
export function distanceToSegment(p: Point, a: Point, b: Point): number {
  const dx = b.x - a.x;
  const dz = b.z - a.z;
  const len2 = dx * dx + dz * dz;
  const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.z - a.z) * dz) / len2));
  return Math.hypot(p.x - (a.x + t * dx), p.z - (a.z + t * dz));
}

export function installInteraction(scn: SceneCtx): void {
  // Picking and dragging.
  const ray = new THREE.Raycaster();
  const ndc = new THREE.Vector2();
  const floor = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
  scn.drag = null;
  let downAt: { x: number; y: number } | null = null;
  const canvas = scn.renderer.domElement;
  scn.canvas = canvas;
  function setRay(e: PointerEvent): void {
    const rect = canvas.getBoundingClientRect();
    ndc.set(
      ((e.clientX - rect.left) / rect.width) * 2 - 1,
      -((e.clientY - rect.top) / rect.height) * 2 + 1,
    );
    ray.setFromCamera(ndc, scn.camera);
  }
  function pick(e: PointerEvent): { kind: PickKind; id: string } | null {
    setRay(e);
    const groups = [...scn.objects.values()].map((o) => o.group);
    groups.push(
      ...scn.transformerObjects.values(),
      ...scn.batteryObjects.values(),
      ...scn.solarObjects.values(),
    );
    const hits = ray
      .intersectObjects(groups, true)
      .filter(
        (h) =>
          h.object.type === 'Mesh' &&
          h.object.userData['ring'] !== true &&
          (h.object.userData['rotateHandle'] == null || scn.editing),
      );
    // A visible rotation handle wins over the station under it.
    const handleHit = hits.find((h) => {
      const id: unknown = h.object.userData['rotateHandle'];
      return typeof id === 'string' && scn.objects.get(id)?.handle?.visible === true;
    });
    if (handleHit != null)
      return { kind: 'handle', id: String(handleHit.object.userData['rotateHandle']) };
    // A station under a solar canopy wins over the roof above it.
    const rest = hits.filter((h) => h.object.userData['rotateHandle'] == null);
    const hit = rest.find((h) => typeof h.object.userData['stationId'] === 'string') ?? rest[0];
    if (hit == null) return null;
    const stationId: unknown = hit.object.userData['stationId'];
    if (typeof stationId === 'string') return { kind: 'station', id: stationId };
    const transformerId: unknown = hit.object.userData['transformerId'];
    if (typeof transformerId === 'string') return { kind: 'transformer', id: transformerId };
    const batteryId: unknown = hit.object.userData['batteryId'];
    if (typeof batteryId === 'string') return { kind: 'battery', id: batteryId };
    const solarId: unknown = hit.object.userData['solarId'];
    if (typeof solarId === 'string') return { kind: 'solar', id: solarId };
    return null;
  }
  /** The station whose virtual status sign is under the pointer, or null. */
  function pickVirtualSign(e: PointerEvent): string | null {
    if (scn.virtualSprites.size === 0) return null;
    setRay(e);
    const hit = ray.intersectObjects([...scn.virtualSprites.values()], false)[0];
    const id: unknown = hit?.object.userData['virtualSign'];
    return typeof id === 'string' ? id : null;
  }

  /** How near the pointer's ground point must be to a cable run to hover it, in meters. */
  const LINK_HOVER_M = 0.45;
  /**
   * The power equipment under the pointer (its label key, `onEquipmentHover`):
   * a transformer, battery, solar canopy or switchboard model, else a cable
   * run within `LINK_HOVER_M` of the pointer's ground point.
   */
  function pickEquipment(e: PointerEvent): string | null {
    setRay(e);
    const groups: THREE.Object3D[] = [
      ...scn.transformerObjects.values(),
      ...scn.batteryObjects.values(),
      ...scn.solarObjects.values(),
    ];
    scn.site.traverse((o) => {
      if (
        o !== scn.site &&
        (o.userData['panelId'] != null || o.userData['solarRowIds'] != null) &&
        o.parent === scn.site
      ) {
        groups.push(o);
      }
    });
    const hit = ray.intersectObjects(groups, true).find((h) => h.object.type === 'Mesh');
    if (hit != null) {
      const d = hit.object.userData;
      if (typeof d['transformerId'] === 'string') return `transformer:${d['transformerId']}`;
      if (typeof d['batteryId'] === 'string') return `energy:${d['batteryId']}`;
      if (typeof d['solarId'] === 'string') return `energy:${d['solarId']}`;
      if (typeof d['panelId'] === 'string') return `panel:${d['panelId']}`;
      const rowIds: unknown = d['solarRowIds'];
      if (Array.isArray(rowIds) && rowIds.length > 0) {
        const at = scn.site.worldToLocal(hit.point.clone());
        let best: string | null = null;
        let bestD = Infinity;
        for (const id of rowIds as string[]) {
          const p = scn.energyLabels.get(id);
          const dist = p == null ? Infinity : Math.abs(p.z - at.z);
          if (dist < bestD) {
            bestD = dist;
            best = id;
          }
        }
        return best != null ? `energy:${best}` : null;
      }
    }
    if (ray.ray.intersectPlane(floor, new THREE.Vector3()) == null) return null;
    const ground = groundPoint(e);
    if (ground == null) return null;
    let best: string | null = null;
    let bestD = LINK_HOVER_M;
    for (const seg of scn.layout.links.segments) {
      for (let i = 1; i < seg.points.length; i++) {
        const a = seg.points[i - 1];
        const b = seg.points[i];
        if (a == null || b == null) continue;
        const d = distanceToSegment({ x: ground.x, z: ground.z }, a, b);
        if (d < bestD) {
          bestD = d;
          best = seg.flowId;
        }
      }
    }
    // A run whose label is a link label (a station branch without an allocated limit has none).
    return best != null && scn.linkLabels.has(best) ? best : null;
  }

  // The pointer on the ground, in lot coordinates.
  function groundPoint(e: PointerEvent): THREE.Vector3 | null {
    setRay(e);
    const p = new THREE.Vector3();
    if (ray.ray.intersectPlane(floor, p) == null) return null;
    return scn.site.worldToLocal(p);
  }
  // Stations move freely on a custom site only; a depot station moves by slot.
  function freeMoves(): boolean {
    return scn.layout.lot.siteType === 'custom';
  }
  // The free position a station's group shows now (custom site).
  function groupPlacement(g: THREE.Object3D): FreePlacement {
    const id = g.userData['stationId'] as string | undefined;
    const spotType = id != null ? scn.objects.get(id)?.station.free?.spotType : undefined;
    return {
      x: g.position.x,
      z: g.position.z,
      rotationDeg: (-g.rotation.y * 180) / Math.PI,
      ...(spotType != null ? { spotType } : {}),
    };
  }
  function showFreeState(obj: StationObject, p: FreePlacement): void {
    const state = scn.callbacks.freeDropState?.(obj.station.id, p) ?? {
      blocked: false,
      guides: [],
    };
    obj.ring.material.color.set(state.blocked ? scn.theme.destructive : scn.theme.primary);
    obj.ring.material.opacity = 0.9;
    scn.showGuides(state.guides);
  }
  function onPointerDown(e: PointerEvent): void {
    downAt = { x: e.clientX, y: e.clientY };
    if (!scn.editing) return;
    const hit = pick(e);
    if (hit == null) return;
    // A grid site's canopy covers a row: it does not move.
    if (hit.kind === 'solar' && !scn.solarObjects.has(hit.id)) return;
    const p = groundPoint(e);
    let grab: Point = { x: 0, z: 0 };
    const g =
      hit.kind === 'station' || hit.kind === 'handle'
        ? scn.objects.get(hit.id)?.group
        : hit.kind === 'solar'
          ? scn.solarObjects.get(hit.id)
          : undefined;
    if (p != null && g != null) grab = { x: p.x - g.position.x, z: p.z - g.position.z };
    scn.drag = {
      ...hit,
      pointerId: e.pointerId,
      grab,
      start: { x: e.clientX, y: e.clientY },
      moved: false,
    };
    scn.controls.enabled = false;
    canvas.setPointerCapture(e.pointerId);
  }
  scn.onPointerDown = onPointerDown;
  // The station under a mouse or pen pointer, reported once per change.
  let hovered: string | null = null;
  function hoverStation(id: string | null): void {
    if (id === hovered) return;
    hovered = id;
    scn.callbacks.onHover?.(id);
  }
  // The equipment whose label shows, reported once per change.
  let hoveredEquipment: string | null = null;
  function hoverEquipment(key: string | null): void {
    if (key === hoveredEquipment) return;
    hoveredEquipment = key;
    scn.callbacks.onEquipmentHover?.(key);
  }
  function onPointerLeave(): void {
    hoverStation(null);
    hoverEquipment(null);
  }
  scn.onPointerLeave = onPointerLeave;
  function onPointerMove(e: PointerEvent): void {
    if (scn.drag == null) {
      if (e.pointerType === 'mouse' || e.pointerType === 'pen') {
        const hit = pick(e);
        canvas.style.cursor = hit != null ? (scn.editing ? 'grab' : 'pointer') : 'default';
        // A virtual status sign shows its time window instead of the station tooltip.
        const sign = pickVirtualSign(e);
        // A charger screen shows its zoom instead of the station tooltip.
        const screen =
          sign == null && hit?.kind === 'station' ? pickChargerScreen(scn, ray, hit.id) : null;
        hoverStation(sign == null && screen == null && hit?.kind === 'station' ? hit.id : null);
        hoverEquipment(
          sign != null
            ? `virtual:${sign}`
            : screen != null
              ? screen
              : hit?.kind === 'station' || hit?.kind === 'handle'
                ? null
                : pickEquipment(e),
        );
      }
      return;
    }
    hoverStation(null);
    hoverEquipment(null);
    if (
      !scn.drag.moved &&
      Math.hypot(e.clientX - scn.drag.start.x, e.clientY - scn.drag.start.y) <= 5
    )
      return;
    scn.drag.moved = true;
    const p = groundPoint(e);
    if (p == null) return;
    if (scn.drag.kind === 'transformer' || scn.drag.kind === 'battery') {
      const g = (scn.drag.kind === 'battery' ? scn.batteryObjects : scn.transformerObjects).get(
        scn.drag.id,
      );
      if (g == null) return;
      const snapped = scn.callbacks.snapTransformer({ x: p.x, z: p.z });
      g.position.set(snapped.x, 0, snapped.z);
      return;
    }
    if (scn.drag.kind === 'solar') {
      const g = scn.solarObjects.get(scn.drag.id);
      if (g == null || scn.callbacks.snapFree == null) return;
      const snapped = scn.callbacks.snapFree(
        { x: p.x - scn.drag.grab.x, z: p.z - scn.drag.grab.z, rotationDeg: 0 },
        false,
      );
      g.position.set(snapped.x, 0, snapped.z);
      return;
    }
    const obj = scn.objects.get(scn.drag.id);
    if (obj == null) return;
    if (obj.station.free != null && freeMoves() && scn.callbacks.snapFree != null) {
      if (scn.drag.kind === 'handle') {
        // Turn toward the pointer; Shift turns to any angle.
        const deg = handleRotation(
          { x: obj.group.position.x, z: obj.group.position.z },
          p,
          e.shiftKey,
        );
        obj.group.rotation.y = (-deg * Math.PI) / 180;
      } else {
        const snapped = scn.callbacks.snapFree(
          {
            x: p.x - scn.drag.grab.x,
            z: p.z - scn.drag.grab.z,
            rotationDeg: groupPlacement(obj.group).rotationDeg,
          },
          true,
        );
        obj.group.position.set(snapped.x, 0, snapped.z);
      }
      showFreeState(obj, groupPlacement(obj.group));
      return;
    }
    const clamped = clampToLot(p.x, p.z, scn.layout.lot);
    obj.group.position.x = clamped.x;
    obj.group.position.z = clamped.z;
    const over = lotToBay(obj.group.position.x, obj.group.position.z, scn.layout.lot);
    if (over == null) return;
    // Turn with the row it is over, so the drop preview faces its lane.
    obj.group.rotation.y = bayTurn(over, scn.layout.lot);
    const blocked = scn.callbacks.isBayTaken(over, scn.drag.id);
    obj.ring.material.color.set(blocked ? scn.theme.destructive : scn.theme.primary);
    obj.ring.material.opacity = 0.9;
  }
  scn.onPointerMove = onPointerMove;
  function onPointerUp(e: PointerEvent): void {
    if (scn.drag != null) {
      const { id, kind, moved } = scn.drag;
      scn.drag = null;
      scn.controls.enabled = true;
      if (canvas.hasPointerCapture(e.pointerId)) canvas.releasePointerCapture(e.pointerId);
      scn.showGuides([]);
      // A click without a move selects (Edit Layout).
      if (!moved) {
        if (kind === 'station' || kind === 'handle') {
          scn.callbacks.onSolarPick?.(null);
          scn.callbacks.onPick(id);
        } else if (kind === 'solar') {
          scn.callbacks.onPick(null);
          scn.callbacks.onSolarPick?.(id);
        }
        return;
      }
      if (kind === 'transformer') {
        const g = scn.transformerObjects.get(id);
        if (g != null) scn.callbacks.onTransformerDrop(id, { x: g.position.x, z: g.position.z });
        return;
      }
      if (kind === 'battery') {
        const g = scn.batteryObjects.get(id);
        if (g != null) scn.callbacks.onBatteryDrop(id, { x: g.position.x, z: g.position.z });
        return;
      }
      if (kind === 'solar') {
        const g = scn.solarObjects.get(id);
        if (g != null) scn.callbacks.onSolarDrop?.(id, { x: g.position.x, z: g.position.z });
        return;
      }
      const obj = scn.objects.get(id);
      if (obj != null) {
        if (obj.station.free != null && freeMoves()) {
          const placement = groupPlacement(obj.group);
          // Back to its position until the new layout arrives (or for good when refused).
          const pose = scn.poseOf(obj.station);
          obj.group.position.copy(scn.lotPoint(pose.point));
          obj.group.rotation.y = pose.turn;
          scn.applySelection();
          scn.callbacks.onFreeDrop?.(id, placement);
          return;
        }
        const bay = lotToBay(obj.group.position.x, obj.group.position.z, scn.layout.lot);
        // Back to its spot until the new positions arrive.
        const home = scn.poseOf(obj.station);
        obj.group.position.copy(scn.lotPoint(home.point));
        obj.group.rotation.y = home.turn;
        scn.applySelection();
        if (bay != null) scn.callbacks.onDrop(id, bay);
      }
      return;
    }
    if (downAt != null && Math.hypot(e.clientX - downAt.x, e.clientY - downAt.y) > 5) return;
    const hit = pick(e);
    if (scn.editing) scn.callbacks.onSolarPick?.(null);
    scn.callbacks.onPick(hit?.kind === 'station' ? hit.id : null);
    // A tap (touch) shows the label of the equipment under it; a tap elsewhere hides it.
    if (e.pointerType === 'touch') {
      const sign = pickVirtualSign(e);
      hoverEquipment(
        sign != null ? `virtual:${sign}` : hit?.kind === 'station' ? null : pickEquipment(e),
      );
    }
  }
  scn.onPointerUp = onPointerUp;
}
