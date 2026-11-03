// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

// The source of every 3D site scene module (site-layout-scene*.ts) as one
// text, for tests that check how the scene wires its models.

const modules = import.meta.glob<string>('../../site-layout-scene*.ts', {
  query: '?raw',
  import: 'default',
  eager: true,
});

export const sceneSource = Object.keys(modules)
  .sort()
  .map((k) => modules[k] ?? '')
  .join('\n');
