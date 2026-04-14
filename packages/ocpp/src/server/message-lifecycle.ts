// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { Logger } from '@evtivity/lib';

export const MessageState = {
  Pending: 'Pending',
  Processing: 'Processing',
  Responded: 'Responded',
  Error: 'Error',
} as const;

export type MessageState = (typeof MessageState)[keyof typeof MessageState];

export interface MessageRecord {
  messageId: string;
  stationId: string;
  action: string;
  state: MessageState;
  receivedAt: Date;
  processingStartedAt: Date | null;
  completedAt: Date | null;
  errorCode: string | null;
  durationMs: number | null;
}

export class MessageLifecycle {
  private readonly messages = new Map<string, MessageRecord>();
  private readonly logger: Logger;
  private readonly maxRecords: number;

  constructor(logger: Logger, maxRecords: number = 10_000) {
    this.logger = logger;
    this.maxRecords = maxRecords;
  }

  received(messageId: string, stationId: string, action: string): void {
    this.evictIfNeeded();
    const record: MessageRecord = {
      messageId,
      stationId,
      action,
      state: MessageState.Pending,
      receivedAt: new Date(),
      processingStartedAt: null,
      completedAt: null,
      errorCode: null,
      durationMs: null,
    };
    this.messages.set(messageId, record);
    this.logger.debug(
      { messageId, action, stationId, state: MessageState.Pending },
      'Message received',
    );
  }

  processing(messageId: string): void {
    const record = this.messages.get(messageId);
    if (record == null) return;
    record.state = MessageState.Processing;
    record.processingStartedAt = new Date();
    this.logger.debug(
      { messageId, action: record.action, state: MessageState.Processing },
      'Message processing',
    );
  }

  responded(messageId: string): void {
    const record = this.messages.get(messageId);
    if (record == null) return;
    record.state = MessageState.Responded;
    record.completedAt = new Date();
    record.durationMs = record.completedAt.getTime() - record.receivedAt.getTime();
    this.logger.debug(
      {
        messageId,
        action: record.action,
        state: MessageState.Responded,
        durationMs: record.durationMs,
      },
      'Message responded',
    );
  }

  errored(messageId: string, errorCode: string): void {
    const record = this.messages.get(messageId);
    if (record == null) return;
    record.state = MessageState.Error;
    record.completedAt = new Date();
    record.durationMs = record.completedAt.getTime() - record.receivedAt.getTime();
    record.errorCode = errorCode;
    this.logger.debug(
      {
        messageId,
        action: record.action,
        state: MessageState.Error,
        errorCode,
        durationMs: record.durationMs,
      },
      'Message errored',
    );
  }

  get(messageId: string): MessageRecord | undefined {
    return this.messages.get(messageId);
  }

  getByStation(stationId: string): MessageRecord[] {
    const records: MessageRecord[] = [];
    for (const record of this.messages.values()) {
      if (record.stationId === stationId) {
        records.push(record);
      }
    }
    return records;
  }

  getStats(): {
    total: number;
    pending: number;
    processing: number;
    responded: number;
    errored: number;
  } {
    let pending = 0;
    let processing = 0;
    let responded = 0;
    let errored = 0;
    for (const record of this.messages.values()) {
      switch (record.state) {
        case MessageState.Pending:
          pending++;
          break;
        case MessageState.Processing:
          processing++;
          break;
        case MessageState.Responded:
          responded++;
          break;
        case MessageState.Error:
          errored++;
          break;
      }
    }
    return { total: this.messages.size, pending, processing, responded, errored };
  }

  private evictIfNeeded(): void {
    if (this.messages.size < this.maxRecords) return;
    const toRemove: string[] = [];
    for (const [id, record] of this.messages) {
      if (record.state === MessageState.Responded || record.state === MessageState.Error) {
        toRemove.push(id);
      }
      if (this.messages.size - toRemove.length < this.maxRecords * 0.8) break;
    }
    for (const id of toRemove) {
      this.messages.delete(id);
    }
  }
}
