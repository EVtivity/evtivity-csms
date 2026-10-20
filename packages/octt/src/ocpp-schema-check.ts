// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { Ajv, type ValidateFunction } from 'ajv';
import addFormatsModule from 'ajv-formats';
import { readOcppSchemaText } from './ocpp-schema-files.js';
import type { OcppVersion } from './types.js';

// ajv-formats is CommonJS: under NodeNext its default import is the module, the plugin is `.default`.
const addFormats = addFormatsModule.default;

/** The schema folder of each version (OCPP 2.1 and 2.0.1 Part 3, OCPP 1.6 JSON). */
const SCHEMA_DIRS: Readonly<Record<OcppVersion, string>> = {
  'ocpp2.1': 'ocpp-2.1',
  'ocpp2.0.1': 'ocpp-2.0.1',
  'ocpp1.6': 'ocpp-1.6',
};

const VERSION_LABELS: Readonly<Record<OcppVersion, string>> = {
  'ocpp2.1': 'OCPP 2.1',
  'ocpp2.0.1': 'OCPP 2.0.1',
  'ocpp1.6': 'OCPP 1.6',
};

export function ocppVersionLabel(version: OcppVersion): string {
  return VERSION_LABELS[version];
}

/** A CALL (`request`), a CALLRESULT (`response`) or a 2.1 SEND message (`send`). */
export type OcppMessageKind = 'request' | 'response' | 'send';

/**
 * The schema file of a message: `<Action>Request.json` and
 * `<Action>Response.json` for 2.1 and 2.0.1, `<Action>.json` and
 * `<Action>Response.json` for 1.6, and `<Action>.json` for a 2.1 SEND
 * message (NotifyPeriodicEventStream).
 */
function schemaPath(version: OcppVersion, action: string, kind: OcppMessageKind): string {
  const suffix =
    kind === 'response' ? 'Response' : kind === 'send' || version === 'ocpp1.6' ? '' : 'Request';
  return `${SCHEMA_DIRS[version]}/${action}${suffix}.json`;
}

let ajv: Ajv | null = null;
// Only schemas that exist are cached: the set of schema files is fixed, while
// the action names of misses come from the peer under test, so caching misses
// would grow without bound.
const compiled = new Map<string, ValidateFunction>();

function validator(path: string): ValidateFunction | null {
  const cached = compiled.get(path);
  if (cached != null) return cached;
  const text = readOcppSchemaText(path);
  if (text == null) return null;
  if (ajv == null) {
    ajv = new Ajv({ allErrors: true, strict: false, validateSchema: false, verbose: true });
    addFormats(ajv);
  }
  const schema = JSON.parse(text) as Record<string, unknown>;
  // Each schema compiles on its own; the shared id namespace would clash
  // (`$id` in 2.1 and 2.0.1, the draft-04 `id` in 1.6).
  delete schema['$id'];
  delete schema['id'];
  const validate = ajv.compile(schema);
  compiled.set(path, validate);
  return validate;
}

/** Number of compiled schemas held in the cache. For tests. */
export function compiledSchemaCount(): number {
  return compiled.size;
}

/**
 * Throws when the schemas of a version cannot be read (a checkout or bundle
 * without them), so a run fails at its start instead of reporting every
 * message as an action the version does not define.
 */
export function assertOcppSchemasAvailable(versions: readonly OcppVersion[]): void {
  for (const version of versions) {
    if (validator(schemaPath(version, 'Heartbeat', 'request')) == null) {
      throw new Error(`The ${VERSION_LABELS[version]} JSON schemas are not available`);
    }
  }
}

/**
 * Why a message is not valid for the OCPP version of its connection, or null
 * when it is: the action is not defined in that version, or the payload fails
 * the strict schema of the request or response. A real peer of that version
 * refuses such a message.
 */
export function ocppSchemaError(
  version: OcppVersion,
  action: string,
  kind: OcppMessageKind,
  payload: unknown,
): string | null {
  const label = VERSION_LABELS[version];
  const validate = validator(schemaPath(version, action, kind));
  if (validate == null) return `${action} is not defined in ${label}`;
  if (validate(payload)) return null;
  const errors = (validate.errors ?? [])
    .slice(0, 5)
    .map((e) => {
      const extra =
        e.keyword === 'additionalProperties'
          ? ` (${String((e.params as { additionalProperty?: unknown }).additionalProperty)})`
          : e.keyword === 'enum'
            ? ` (${JSON.stringify((e.params as { allowedValues?: unknown }).allowedValues)}, got ${JSON.stringify(e.data)})`
            : e.keyword === 'type' || e.keyword === 'maxLength'
              ? ` (got ${JSON.stringify(e.data).slice(0, 60)})`
              : '';
      return `${e.instancePath === '' ? '/' : e.instancePath} ${e.message ?? e.keyword}${extra}`;
    })
    .join('; ');
  return `${action} ${kind} fails the ${label} schema: ${errors}`;
}
