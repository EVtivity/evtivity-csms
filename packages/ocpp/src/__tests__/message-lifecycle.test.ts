// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect } from 'vitest';
import { MessageLifecycle, MessageState } from '../server/message-lifecycle.js';
import type { Logger } from '@evtivity/lib';

const mockLogger = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
} as unknown as Logger;

describe('MessageLifecycle', () => {
  describe('received', () => {
    it('creates a Pending record', () => {
      const lifecycle = new MessageLifecycle(mockLogger);
      lifecycle.received('msg-1', 'station-A', 'BootNotification');

      const record = lifecycle.get('msg-1');
      expect(record).toBeDefined();
      expect(record?.state).toBe(MessageState.Pending);
      expect(record?.messageId).toBe('msg-1');
      expect(record?.stationId).toBe('station-A');
      expect(record?.action).toBe('BootNotification');
      expect(record?.receivedAt).toBeInstanceOf(Date);
      expect(record?.processingStartedAt).toBeNull();
      expect(record?.completedAt).toBeNull();
      expect(record?.errorCode).toBeNull();
      expect(record?.durationMs).toBeNull();
    });
  });

  describe('processing', () => {
    it('transitions to Processing state', () => {
      const lifecycle = new MessageLifecycle(mockLogger);
      lifecycle.received('msg-1', 'station-A', 'Heartbeat');
      lifecycle.processing('msg-1');

      const record = lifecycle.get('msg-1');
      expect(record?.state).toBe(MessageState.Processing);
      expect(record?.processingStartedAt).toBeInstanceOf(Date);
    });

    it('does nothing for unknown messageId', () => {
      const lifecycle = new MessageLifecycle(mockLogger);
      lifecycle.processing('nonexistent');

      expect(lifecycle.get('nonexistent')).toBeUndefined();
    });
  });

  describe('responded', () => {
    it('transitions to Responded with duration', () => {
      const lifecycle = new MessageLifecycle(mockLogger);
      lifecycle.received('msg-1', 'station-A', 'Heartbeat');
      lifecycle.processing('msg-1');
      lifecycle.responded('msg-1');

      const record = lifecycle.get('msg-1');
      expect(record?.state).toBe(MessageState.Responded);
      expect(record?.completedAt).toBeInstanceOf(Date);
      expect(record?.durationMs).toBeGreaterThanOrEqual(0);
    });

    it('does nothing for unknown messageId', () => {
      const lifecycle = new MessageLifecycle(mockLogger);
      lifecycle.responded('nonexistent');

      expect(lifecycle.get('nonexistent')).toBeUndefined();
    });
  });

  describe('errored', () => {
    it('transitions to Error with errorCode', () => {
      const lifecycle = new MessageLifecycle(mockLogger);
      lifecycle.received('msg-1', 'station-A', 'Authorize');
      lifecycle.processing('msg-1');
      lifecycle.errored('msg-1', 'InternalError');

      const record = lifecycle.get('msg-1');
      expect(record?.state).toBe(MessageState.Error);
      expect(record?.errorCode).toBe('InternalError');
      expect(record?.completedAt).toBeInstanceOf(Date);
      expect(record?.durationMs).toBeGreaterThanOrEqual(0);
    });

    it('does nothing for unknown messageId', () => {
      const lifecycle = new MessageLifecycle(mockLogger);
      lifecycle.errored('nonexistent', 'InternalError');

      expect(lifecycle.get('nonexistent')).toBeUndefined();
    });
  });

  describe('getStats', () => {
    it('returns correct counts for each state', () => {
      const lifecycle = new MessageLifecycle(mockLogger);

      lifecycle.received('msg-1', 'station-A', 'BootNotification');
      lifecycle.received('msg-2', 'station-A', 'Heartbeat');
      lifecycle.received('msg-3', 'station-B', 'Authorize');
      lifecycle.received('msg-4', 'station-B', 'StatusNotification');

      lifecycle.processing('msg-2');
      lifecycle.processing('msg-3');
      lifecycle.responded('msg-3');
      lifecycle.processing('msg-4');
      lifecycle.errored('msg-4', 'GenericError');

      const stats = lifecycle.getStats();
      expect(stats.total).toBe(4);
      expect(stats.pending).toBe(1);
      expect(stats.processing).toBe(1);
      expect(stats.responded).toBe(1);
      expect(stats.errored).toBe(1);
    });

    it('returns all zeros when empty', () => {
      const lifecycle = new MessageLifecycle(mockLogger);

      const stats = lifecycle.getStats();
      expect(stats.total).toBe(0);
      expect(stats.pending).toBe(0);
      expect(stats.processing).toBe(0);
      expect(stats.responded).toBe(0);
      expect(stats.errored).toBe(0);
    });
  });

  describe('getByStation', () => {
    it('filters records by stationId', () => {
      const lifecycle = new MessageLifecycle(mockLogger);

      lifecycle.received('msg-1', 'station-A', 'BootNotification');
      lifecycle.received('msg-2', 'station-A', 'Heartbeat');
      lifecycle.received('msg-3', 'station-B', 'Authorize');

      const stationARecords = lifecycle.getByStation('station-A');
      expect(stationARecords).toHaveLength(2);
      expect(stationARecords.every((r) => r.stationId === 'station-A')).toBe(true);

      const stationBRecords = lifecycle.getByStation('station-B');
      expect(stationBRecords).toHaveLength(1);
      expect(stationBRecords[0]?.messageId).toBe('msg-3');
    });

    it('returns empty array for unknown stationId', () => {
      const lifecycle = new MessageLifecycle(mockLogger);
      lifecycle.received('msg-1', 'station-A', 'Heartbeat');

      const records = lifecycle.getByStation('station-Z');
      expect(records).toHaveLength(0);
    });
  });

  describe('eviction', () => {
    it('evicts completed records when maxRecords is exceeded', () => {
      const maxRecords = 10;
      const lifecycle = new MessageLifecycle(mockLogger, maxRecords);

      for (let i = 0; i < maxRecords; i++) {
        const id = 'msg-' + String(i);
        lifecycle.received(id, 'station-A', 'Heartbeat');
        lifecycle.processing(id);
        lifecycle.responded(id);
      }

      expect(lifecycle.getStats().total).toBe(maxRecords);

      lifecycle.received('msg-overflow', 'station-A', 'Heartbeat');

      const stats = lifecycle.getStats();
      expect(stats.total).toBeLessThan(maxRecords);
      expect(lifecycle.get('msg-overflow')).toBeDefined();
    });

    it('evicts errored records during eviction', () => {
      const maxRecords = 5;
      const lifecycle = new MessageLifecycle(mockLogger, maxRecords);

      for (let i = 0; i < maxRecords; i++) {
        const id = 'err-' + String(i);
        lifecycle.received(id, 'station-A', 'Authorize');
        lifecycle.processing(id);
        lifecycle.errored(id, 'GenericError');
      }

      expect(lifecycle.getStats().total).toBe(maxRecords);

      lifecycle.received('msg-new', 'station-A', 'Heartbeat');

      const stats = lifecycle.getStats();
      expect(stats.total).toBeLessThan(maxRecords);
      expect(lifecycle.get('msg-new')).toBeDefined();
    });

    it('does not evict Pending or Processing records', () => {
      const maxRecords = 5;
      const lifecycle = new MessageLifecycle(mockLogger, maxRecords);

      for (let i = 0; i < maxRecords; i++) {
        const id = 'pending-' + String(i);
        lifecycle.received(id, 'station-A', 'Heartbeat');
      }

      lifecycle.received('msg-trigger', 'station-A', 'Heartbeat');

      const stats = lifecycle.getStats();
      expect(stats.total).toBe(maxRecords + 1);
      for (let i = 0; i < maxRecords; i++) {
        expect(lifecycle.get('pending-' + String(i))).toBeDefined();
      }
      expect(lifecycle.get('msg-trigger')).toBeDefined();
    });
  });
});
