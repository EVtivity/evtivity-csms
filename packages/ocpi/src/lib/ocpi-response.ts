// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

export enum OcpiStatusCode {
  SUCCESS = 1000,
  CLIENT_ERROR = 2000,
  CLIENT_INVALID_PARAMS = 2001,
  CLIENT_NOT_ENOUGH_INFO = 2002,
  CLIENT_UNKNOWN_LOCATION = 2003,
  CLIENT_UNKNOWN_TOKEN = 2004,
  SERVER_ERROR = 3000,
  SERVER_UNABLE_TO_USE_API = 3001,
  SERVER_UNSUPPORTED_VERSION = 3002,
  SERVER_NO_MATCHING_ENDPOINTS = 3003,
  HUB_UNKNOWN_RECEIVER = 4000,
  HUB_REQUEST_TIMEOUT = 4001,
  HUB_CONNECTION_PROBLEM = 4002,
  HUB_UNSUPPORTED_VERSION = 4003,
}

export interface OcpiResponseEnvelope<T> {
  data: T;
  status_code: OcpiStatusCode;
  status_message: string;
  timestamp: string;
}

export function ocpiResponse<T>(
  data: T,
  statusCode: OcpiStatusCode = OcpiStatusCode.SUCCESS,
  statusMessage: string = 'Success',
): OcpiResponseEnvelope<T> {
  return {
    data,
    status_code: statusCode,
    status_message: statusMessage,
    timestamp: new Date().toISOString(),
  };
}

export function ocpiSuccess<T>(data: T): OcpiResponseEnvelope<T> {
  return ocpiResponse(data, OcpiStatusCode.SUCCESS, 'Success');
}

export function ocpiError(statusCode: OcpiStatusCode, message: string): OcpiResponseEnvelope<null> {
  return ocpiResponse(null, statusCode, message);
}
