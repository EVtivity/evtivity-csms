// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

/**
 * WebSocket upgrade header the EVtivity charging station simulator sends on
 * every connection. The OCPP server uses it to tell the simulator from a real
 * station that connects with the identity of a simulator-flagged station.
 * It is not a credential: a station that forges it only keeps the flag.
 */
export const SIMULATOR_CONNECTION_HEADER = 'x-evtivity-simulator';
export const SIMULATOR_CONNECTION_HEADER_VALUE = 'css';
