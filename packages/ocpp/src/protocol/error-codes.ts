// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

/**
 * CALLERROR error codes. The handlers and middleware use the OCPP 2.x names;
 * `errorCodeForProtocol` turns them into the OCPP 1.6 names where the CALLERROR
 * is built. `FormationViolation` and `OccurenceConstraintViolation` (spelled as
 * in OCPP-J 1.6, table 7) exist only in 1.6.
 */
export const OcppErrorCode = {
  FormatViolation: 'FormatViolation',
  FormationViolation: 'FormationViolation',
  GenericError: 'GenericError',
  InternalError: 'InternalError',
  MessageTypeNotSupported: 'MessageTypeNotSupported',
  NotImplemented: 'NotImplemented',
  NotSupported: 'NotSupported',
  OccurenceConstraintViolation: 'OccurenceConstraintViolation',
  OccurrenceConstraintViolation: 'OccurrenceConstraintViolation',
  PropertyConstraintViolation: 'PropertyConstraintViolation',
  ProtocolError: 'ProtocolError',
  RpcFrameworkError: 'RpcFrameworkError',
  SecurityError: 'SecurityError',
  TypeConstraintViolation: 'TypeConstraintViolation',
} as const;

export type OcppErrorCode = (typeof OcppErrorCode)[keyof typeof OcppErrorCode];

/**
 * OCPP 2.x codes that OCPP-J 1.6 does not define, and the 1.6 code that
 * replaces each: the 1.6 spelling of the same violation, ProtocolError for an
 * invalid RPC frame, and GenericError for an unknown message type (1.6 has no
 * code for it).
 */
const OCPP16_ERROR_CODES: Readonly<Record<string, OcppErrorCode>> = {
  [OcppErrorCode.FormatViolation]: OcppErrorCode.FormationViolation,
  [OcppErrorCode.OccurrenceConstraintViolation]: OcppErrorCode.OccurenceConstraintViolation,
  [OcppErrorCode.RpcFrameworkError]: OcppErrorCode.ProtocolError,
  [OcppErrorCode.MessageTypeNotSupported]: OcppErrorCode.GenericError,
};

/** The error code a CALLERROR carries on a connection of this OCPP version. */
export function errorCodeForProtocol(errorCode: string, protocolVersion: string): string {
  if (protocolVersion !== 'ocpp1.6' || !Object.hasOwn(OCPP16_ERROR_CODES, errorCode)) {
    return errorCode;
  }
  return OCPP16_ERROR_CODES[errorCode] ?? errorCode;
}
