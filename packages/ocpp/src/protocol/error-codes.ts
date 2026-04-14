// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

export const OcppErrorCode = {
  FormatViolation: 'FormatViolation',
  GenericError: 'GenericError',
  InternalError: 'InternalError',
  MessageTypeNotSupported: 'MessageTypeNotSupported',
  NotImplemented: 'NotImplemented',
  NotSupported: 'NotSupported',
  OccurrenceConstraintViolation: 'OccurrenceConstraintViolation',
  PropertyConstraintViolation: 'PropertyConstraintViolation',
  ProtocolError: 'ProtocolError',
  RpcFrameworkError: 'RpcFrameworkError',
  SecurityError: 'SecurityError',
  TypeConstraintViolation: 'TypeConstraintViolation',
} as const;

export type OcppErrorCode = (typeof OcppErrorCode)[keyof typeof OcppErrorCode];
