// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

export interface SessionState {
  stationId: string;
  stationDbId: string | null;
  ocppProtocol: string;
  connectedAt: Date;
  lastHeartbeat: Date;
  authenticated: boolean;
  bootStatus: 'Accepted' | 'Pending' | 'Rejected' | null;
  pendingMessages: Map<string, PendingMessage>;
}

export interface PendingMessage {
  messageId: string;
  action: string;
  sentAt: Date;
  resolve: (response: Record<string, unknown>) => void;
  reject: (error: Error) => void;
  timeout: ReturnType<typeof setTimeout>;
}

export function createSessionState(stationId: string, ocppProtocol?: string): SessionState {
  return {
    stationId,
    stationDbId: null,
    ocppProtocol: ocppProtocol ?? 'ocpp2.1',
    connectedAt: new Date(),
    lastHeartbeat: new Date(),
    authenticated: false,
    bootStatus: null,
    pendingMessages: new Map(),
  };
}
