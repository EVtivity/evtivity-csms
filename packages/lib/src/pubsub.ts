// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

export interface Subscription {
  unsubscribe(): Promise<void>;
}

export interface PubSubClient {
  publish(channel: string, payload: string): Promise<void>;
  subscribe(channel: string, handler: (payload: string) => void): Promise<Subscription>;
  close(): Promise<void>;
}
