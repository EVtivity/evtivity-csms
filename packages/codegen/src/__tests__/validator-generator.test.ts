// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import {
  generateAjvFitSetupFile,
  generateAjvSetupFile,
  generateValidatorFile,
} from '../generators/validator-generator.js';
import { generateRegistryFile } from '../generators/registry-generator.js';
import { generateValidatorsIndex } from '../generators/index-generator.js';
import { groupActionPairs } from '../parsers/action-extractor.js';
import type { ParsedSchema } from '../parsers/schema-parser.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// Outside src/ so tsc never compiles it, inside the package so `ajv` resolves.
const tmpRoot = fs.mkdtempSync(path.join(__dirname, '..', '..', '.test-gen-'));

afterAll(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

function parsed(fileName: string, rawSchema: Record<string, unknown>): ParsedSchema {
  return {
    fileName,
    schemaId: String(rawSchema['$id']),
    definitions: new Map(),
    rootProperties: [],
    rootRequired: [],
    rawSchema,
  };
}

const authorizeResponse = parsed('AuthorizeResponse.json', {
  $schema: 'http://json-schema.org/draft-06/schema#',
  $id: 'urn:test:AuthorizeResponse',
  definitions: {
    CustomDataType: {
      type: 'object',
      properties: { vendorId: { type: 'string', maxLength: 255 } },
      required: ['vendorId'],
    },
    IdTokenInfoType: {
      type: 'object',
      additionalProperties: false,
      properties: {
        customData: { $ref: '#/definitions/CustomDataType' },
        status: { type: 'string' },
      },
      required: ['status'],
    },
  },
  type: 'object',
  additionalProperties: false,
  properties: {
    customData: { $ref: '#/definitions/CustomDataType' },
    idTokenInfo: { $ref: '#/definitions/IdTokenInfoType' },
  },
  required: ['idTokenInfo'],
});

let counter = 0;

async function loadGenerated(
  fileName: string,
  source: string,
): Promise<Record<string, (payload: Record<string, unknown>) => unknown>> {
  counter += 1;
  const dir = path.join(tmpRoot, `case-${String(counter)}`);
  fs.mkdirSync(dir);
  fs.writeFileSync(path.join(dir, '_ajv.ts'), generateAjvSetupFile());
  fs.writeFileSync(path.join(dir, '_ajv-fit.ts'), generateAjvFitSetupFile());
  const filePath = path.join(dir, fileName);
  fs.writeFileSync(filePath, source);
  return (await import(filePath)) as Record<string, (payload: Record<string, unknown>) => unknown>;
}

describe('generateValidatorFile', () => {
  it('emits only the validator without fit functions', async () => {
    const source = generateValidatorFile(authorizeResponse);
    expect(source).not.toContain('fitAuthorizeResponse');
    expect(source).not.toContain('_ajv-fit');
    const mod = await loadGenerated('AuthorizeResponse.validator.ts', source);
    expect(typeof mod['validateAuthorizeResponse']).toBe('function');
  });

  it('emits a fit function that drops properties the 2.0.1 schema does not allow', async () => {
    const mod = await loadGenerated(
      'AuthorizeResponse.validator.ts',
      generateValidatorFile(authorizeResponse, { fit: true }),
    );
    const fit = mod['fitAuthorizeResponse'];
    const validate = mod['validateAuthorizeResponse'];
    expect(typeof validate).toBe('function');
    expect(typeof fit).toBe('function');
    if (fit == null || validate == null) return;

    const input = {
      idTokenInfo: { status: 'Accepted', evseId: [1] },
      tariff: { id: 't1' },
    };
    const fitted = fit(input);
    expect(fitted).toEqual({ idTokenInfo: { status: 'Accepted' } });
    expect(input).toHaveProperty('tariff');
    expect(input.idTokenInfo).toHaveProperty('evseId');
    expect(fitted).not.toBe(input);
    expect(validate(input)).toBe(false);
    expect(validate(fitted as Record<string, unknown>)).toBe(true);
  });

  it('keeps vendor fields in customData, which the schema leaves open', async () => {
    const mod = await loadGenerated(
      'AuthorizeResponse.validator.ts',
      generateValidatorFile(authorizeResponse, { fit: true }),
    );
    const fit = mod['fitAuthorizeResponse'];
    if (fit == null) throw new Error('fit function missing');
    const input = {
      customData: { vendorId: 'acme', extra: 1 },
      idTokenInfo: { status: 'Accepted' },
    };
    expect(fit(input)).toEqual(input);
  });
});

describe('generateRegistryFile', () => {
  const pairs = groupActionPairs([
    parsed('AuthorizeRequest.json', { $id: 'urn:test:AuthorizeRequest' }),
    authorizeResponse,
  ]);

  it('carries only validators by default', () => {
    const source = generateRegistryFile(pairs);
    expect(source).not.toContain('fitRequest');
    expect(source).toContain('validateRequest: validateAuthorizeRequest,');
  });

  it('carries fitRequest and fitResponse when fit functions are on', () => {
    const source = generateRegistryFile(pairs, { fit: true });
    expect(source).toContain(
      `import { validateAuthorizeRequest, fitAuthorizeRequest } from './validators/AuthorizeRequest.validator.js';`,
    );
    expect(source).toContain('fitRequest: fitAuthorizeRequest,');
    expect(source).toContain('fitResponse: fitAuthorizeResponse,');
  });

  it('exports the fit functions from the validators index when on', () => {
    expect(generateValidatorsIndex(pairs)).not.toContain('fitAuthorizeRequest');
    expect(generateValidatorsIndex(pairs, { fit: true })).toContain(
      `export { validateAuthorizeRequest, fitAuthorizeRequest } from './AuthorizeRequest.validator.js';`,
    );
  });
});
