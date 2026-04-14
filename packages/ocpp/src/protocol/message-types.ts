// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

export const MESSAGE_TYPE_CALL = 2;
export const MESSAGE_TYPE_CALLRESULT = 3;
export const MESSAGE_TYPE_CALLERROR = 4;

export type Call = [typeof MESSAGE_TYPE_CALL, string, string, Record<string, unknown>];

export type CallResult = [typeof MESSAGE_TYPE_CALLRESULT, string, Record<string, unknown>];

export type CallError = [
  typeof MESSAGE_TYPE_CALLERROR,
  string,
  string,
  string,
  Record<string, unknown>,
];

export type OcppMessage = Call | CallResult | CallError;

export function isCall(msg: OcppMessage): msg is Call {
  return msg[0] === MESSAGE_TYPE_CALL;
}

export function isCallResult(msg: OcppMessage): msg is CallResult {
  return msg[0] === MESSAGE_TYPE_CALLRESULT;
}

export function isCallError(msg: OcppMessage): msg is CallError {
  return msg[0] === MESSAGE_TYPE_CALLERROR;
}

export function createCallResult(messageId: string, payload: Record<string, unknown>): CallResult {
  return [MESSAGE_TYPE_CALLRESULT, messageId, payload];
}

export function createCallError(
  messageId: string,
  errorCode: string,
  errorDescription: string,
  errorDetails: Record<string, unknown> = {},
): CallError {
  return [MESSAGE_TYPE_CALLERROR, messageId, errorCode, errorDescription, errorDetails];
}

export function createCall(
  messageId: string,
  action: string,
  payload: Record<string, unknown>,
): Call {
  return [MESSAGE_TYPE_CALL, messageId, action, payload];
}
