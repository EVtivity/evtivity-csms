// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { DEFAULT_DATA_PLAN } from '@evtivity/lib';
import type { DataPlan } from '@evtivity/lib';

export interface SessionState {
  stationId: string;
  stationDbId: string | null;
  ocppProtocol: string;
  connectedAt: Date;
  lastHeartbeat: Date;
  authenticated: boolean;
  bootStatus: 'Accepted' | 'Pending' | 'Rejected' | null;
  /** station.Ready was published for this connection. */
  readyAnnounced: boolean;
  /** The station's effective data plan, read at connect, at each boot and on a plan change. */
  dataPlan: DataPlan;
  /** When the last frame (message, ping or pong) arrived on this connection. */
  lastInboundAt: Date;
  /** The station answered a CSMS ping on this connection (enables the missed-pong close). */
  answeredPing: boolean;
  /** When the CSMS last pinged this connection; unset until the first ping. */
  lastPingAt?: Date;
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
    readyAnnounced: false,
    dataPlan: DEFAULT_DATA_PLAN,
    lastInboundAt: new Date(),
    answeredPing: false,
    pendingMessages: new Map(),
  };
}
