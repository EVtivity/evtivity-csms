// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect } from 'vitest';
import { extractActionInfo, groupActionPairs } from '../parsers/action-extractor.js';
import type { ParsedSchema } from '../parsers/schema-parser.js';

function fakeSchema(fileName: string): ParsedSchema {
  return {
    fileName,
    schemaId: `urn:ocpp:2.1:${fileName}`,
    definitions: new Map(),
    rootProperties: [],
    rootRequired: [],
    rawSchema: {},
  };
}

describe('extractActionInfo', () => {
  it('extracts Request action', () => {
    const info = extractActionInfo(fakeSchema('BootNotificationRequest.json'));
    expect(info.action).toBe('BootNotification');
    expect(info.messageType).toBe('Request');
  });

  it('extracts Response action', () => {
    const info = extractActionInfo(fakeSchema('BootNotificationResponse.json'));
    expect(info.action).toBe('BootNotification');
    expect(info.messageType).toBe('Response');
  });

  it('marks non-Request/Response as Standalone', () => {
    const info = extractActionInfo(fakeSchema('NotifyPeriodicEventStream.json'));
    expect(info.action).toBe('NotifyPeriodicEventStream');
    expect(info.messageType).toBe('Standalone');
  });
});

describe('groupActionPairs', () => {
  it('groups request and response into a pair', () => {
    const schemas = [fakeSchema('HeartbeatRequest.json'), fakeSchema('HeartbeatResponse.json')];
    const pairs = groupActionPairs(schemas);

    expect(pairs.size).toBe(1);
    const pair = pairs.get('Heartbeat');
    expect(pair?.request?.messageType).toBe('Request');
    expect(pair?.response?.messageType).toBe('Response');
  });

  it('handles standalone messages', () => {
    const schemas = [fakeSchema('NotifyPeriodicEventStream.json')];
    const pairs = groupActionPairs(schemas);

    expect(pairs.size).toBe(1);
    const pair = pairs.get('NotifyPeriodicEventStream');
    expect(pair?.request?.messageType).toBe('Standalone');
    expect(pair?.response).toBeUndefined();
  });

  it('groups multiple actions correctly', () => {
    const schemas = [
      fakeSchema('BootNotificationRequest.json'),
      fakeSchema('BootNotificationResponse.json'),
      fakeSchema('HeartbeatRequest.json'),
      fakeSchema('HeartbeatResponse.json'),
    ];
    const pairs = groupActionPairs(schemas);
    expect(pairs.size).toBe(2);
    expect(pairs.has('BootNotification')).toBe(true);
    expect(pairs.has('Heartbeat')).toBe(true);
  });
});
