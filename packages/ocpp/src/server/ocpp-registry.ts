// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { ActionRegistry as Registry21 } from '../generated/v2_1/registry.js';
import { ActionRegistry as Registry201 } from '../generated/v2_0_1/registry.js';
import { ActionRegistry as Registry16 } from '../generated/v1_6/registry.js';

export interface AjvError {
  keyword?: string;
  instancePath?: string;
  schemaPath?: string;
  params?: Record<string, unknown>;
  message?: string;
}

type ValidateFn = ((data: unknown) => boolean) & { errors?: AjvError[] | null };

/** The schema checks of one OCPP action in one protocol version. */
export interface ActionSchemaEntry {
  validateRequest: ValidateFn;
  validateResponse: ValidateFn;
}

type FitFn = (payload: Record<string, unknown>) => Record<string, unknown>;

/** A 2.0.1 action's checks plus the generated fits, which copy a payload without what 2.0.1 does not allow. */
export interface Ocpp201ActionSchemaEntry extends ActionSchemaEntry {
  fitRequest: FitFn;
  fitResponse: FitFn;
}

const registry201: Readonly<Record<string, Ocpp201ActionSchemaEntry>> = Registry201;
const registry21: Readonly<Record<string, ActionSchemaEntry>> = Registry21;

/** The generated action registry of a connection's protocol: 1.6, 2.0.1, else 2.1. */
function registryFor(protocolVersion: string): Readonly<Record<string, ActionSchemaEntry>> {
  if (protocolVersion === 'ocpp1.6') return Registry16;
  if (protocolVersion === 'ocpp2.0.1') return registry201;
  return Registry21;
}

/** The 2.0.1 entry of an action, or undefined when 2.0.1 does not define it (own keys only). */
export function ocpp201ActionSchemaEntry(action: string): Ocpp201ActionSchemaEntry | undefined {
  return Object.hasOwn(registry201, action) ? registry201[action] : undefined;
}

/** The 2.1 entry of an action, or undefined when 2.1 does not define it (own keys only). */
export function ocpp21ActionSchemaEntry(action: string): ActionSchemaEntry | undefined {
  return Object.hasOwn(registry21, action) ? registry21[action] : undefined;
}

/** The actions the generated 2.1 registry has and the 2.0.1 registry lacks (`OCPP21_ONLY_ACTIONS` in lib). */
export function ocpp21OnlyRegistryActions(): string[] {
  return Object.keys(registry21).filter((action) => ocpp201ActionSchemaEntry(action) == null);
}

/**
 * The schema entry of an action in the connection's protocol, or undefined when
 * the protocol does not define the action. Own keys only: an action named after
 * an Object.prototype member (`constructor`, `toString`) is not in a registry.
 */
export function actionSchemaEntry(
  protocolVersion: string,
  action: string,
): ActionSchemaEntry | undefined {
  const registry = registryFor(protocolVersion);
  return Object.hasOwn(registry, action) ? registry[action] : undefined;
}

/**
 * The protocol whose handlers answer a CALL. OCPP 2.0.1 connections use the 2.1
 * handlers, for the actions OCPP 2.0.1 defines; a 2.1-only action from a 2.0.1
 * station has no handler (null), so it is answered as an unknown action.
 */
export function handlerProtocolFor(protocolVersion: string, action: string): string | null {
  if (protocolVersion !== 'ocpp2.0.1') return protocolVersion;
  return ocpp201ActionSchemaEntry(action) != null ? 'ocpp2.1' : null;
}
