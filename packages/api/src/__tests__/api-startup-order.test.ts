// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

// Fastify refuses addHook once it listens ("Fastify instance is already
// listening"), which stopped the API at start when the bus depot interface
// registered its close hook after listen. Every hook and the depot server
// attach come before the listen call.
describe('API start order', () => {
  it('registers every hook and the bus depot server before it listens', () => {
    const source = readFileSync(resolve(import.meta.dirname, '../index.ts'), 'utf8');
    const listenAt = source.indexOf('await app.listen(');
    expect(listenAt).toBeGreaterThan(0);
    const afterListen = source.slice(listenAt);
    expect(afterListen).not.toMatch(/app\.addHook\(/);
    expect(afterListen).not.toMatch(/attachVdv463Server\(/);
    expect(source.slice(0, listenAt)).toMatch(/attachVdv463Server\(/);
  });
});
