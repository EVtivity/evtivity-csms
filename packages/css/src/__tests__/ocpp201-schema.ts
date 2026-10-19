// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { existsSync, readFileSync } from 'node:fs';
import { Ajv, type ValidateFunction } from 'ajv';
import addFormatsModule from 'ajv-formats';

// ajv-formats is CommonJS: under NodeNext its default import is the module, the plugin is `.default`.
const addFormats = addFormatsModule.default;

const ajv = new Ajv({ allErrors: true, strict: false, validateSchema: false });
addFormats(ajv);

const compiled = new Map<string, ValidateFunction>();

function validator(file: string): ValidateFunction | null {
  const cached = compiled.get(file);
  if (cached != null) return cached;
  const url = new URL(`../../../../schemas/ocpp-2.0.1/${file}.json`, import.meta.url);
  if (!existsSync(url)) return null;
  const schema = JSON.parse(readFileSync(url, 'utf8')) as Record<string, unknown>;
  delete schema['$id'];
  const validate = ajv.compile(schema);
  compiled.set(file, validate);
  return validate;
}

/** Whether OCPP 2.0.1 defines the message. */
export function isOcpp201Message(action: string): boolean {
  return validator(`${action}Request`) != null;
}

/**
 * The strict OCPP 2.0.1 check a real 2.0.1 peer runs (schemas/ocpp-2.0.1, every
 * object closed): throws with the schema errors when the payload fails it.
 */
export function assertOcpp201(
  action: string,
  kind: 'request' | 'response',
  payload: Record<string, unknown>,
): void {
  const validate = validator(`${action}${kind === 'request' ? 'Request' : 'Response'}`);
  if (validate == null) throw new Error(`${action} is not an OCPP 2.0.1 message`);
  if (!validate(payload)) {
    throw new Error(
      `${action} ${kind} fails the OCPP 2.0.1 schema: ${JSON.stringify(validate.errors)} in ${JSON.stringify(payload)}`,
    );
  }
}
