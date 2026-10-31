// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, expect, it } from 'vitest';
import { generatedAvatarProblem } from '@evtivity/lib/account-avatar';
import { demoDriverAvatar } from '../seed-demo-avatars.js';

const ids = Array.from({ length: 300 }, (_, i) => `drv_${String(i).padStart(12, '0')}`);

describe('demo driver avatars', () => {
  it('passes the avatar allow-list for every driver and stays the same per driver', () => {
    for (const id of ids) {
      const avatar = demoDriverAvatar(id);
      expect(generatedAvatarProblem(avatar), id).toBeNull();
      expect(demoDriverAvatar(id)).toEqual(avatar);
    }
  });

  it('varies the faces and keeps them ordinary', () => {
    const avatars = ids.map((id) => demoDriverAvatar(id).options);
    expect(new Set(avatars.map((o) => o['topVariant'])).size).toBeGreaterThan(10);
    expect(new Set(avatars.map((o) => o['skinColor'])).size).toBe(5);
    const glasses = avatars.filter((o) => o['accessoriesProbability'] === 100).length;
    expect(glasses).toBeGreaterThan(20);
    expect(glasses).toBeLessThan(120);
    for (const o of avatars) {
      expect(['eyepatch', 'kurt', 'sunglasses', 'wayfarers']).not.toContain(
        o['accessoriesVariant'],
      );
      expect(['hat', 'hijab', 'turban', 'winterHat1']).not.toContain(o['topVariant']);
      expect(o['clothesVariant']).not.toBe('graphicShirt');
      expect(o['topProbability']).toBe(100);
    }
  });
});
