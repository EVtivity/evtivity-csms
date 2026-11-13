// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, expect, it } from 'vitest';
import {
  cleanSchema,
  collectFieldNames,
  dropStrictNulls,
  toStrictSchema,
  withPropertyEnum,
  withoutProperties,
} from '../services/ai/tools/schema.js';

describe('cleanSchema', () => {
  it('drops model-irrelevant keywords at every depth without mutating the input', () => {
    const input = {
      type: 'object',
      title: 'T',
      $schema: 'x',
      properties: {
        a: { type: 'string', default: 'x', example: 'y', description: 'd' },
        b: true,
        list: { type: 'array', items: { type: 'string', examples: ['z'] } },
        map: { type: 'object', additionalProperties: { type: 'number', readOnly: true } },
        u: { anyOf: [{ type: 'string', title: 's' }, 5] },
        o: { oneOf: [{ type: 'string', default: 'a' }] },
        all: { allOf: [{ type: 'number', title: 'n' }] },
      },
    };
    const copy = structuredClone(input);
    expect(cleanSchema(input)).toEqual({
      type: 'object',
      properties: {
        a: { type: 'string', description: 'd' },
        b: true,
        list: { type: 'array', items: { type: 'string' } },
        map: { type: 'object', additionalProperties: { type: 'number' } },
        u: { anyOf: [{ type: 'string' }, 5] },
        o: { oneOf: [{ type: 'string' }] },
        all: { allOf: [{ type: 'number' }] },
      },
    });
    expect(input).toEqual(copy);
  });

  it('keeps a boolean additionalProperties as is', () => {
    expect(cleanSchema({ type: 'object', additionalProperties: false })).toEqual({
      type: 'object',
      additionalProperties: false,
    });
  });
});

describe('toStrictSchema', () => {
  it('closes objects, requires every property and makes optional ones nullable', () => {
    expect(
      toStrictSchema({
        type: 'object',
        format: 'ignored',
        required: ['id'],
        properties: {
          id: { type: 'string', pattern: '^a' },
          status: { type: 'string', enum: ['on', 'off'] },
          tags: { type: 'array', items: { type: 'string' } },
          site: { type: 'string', nullable: true },
          multi: { type: ['string', 'number'] },
          already: { type: ['string', 'null'] },
          anything: { description: 'untyped' },
        },
      }),
    ).toEqual({
      type: 'object',
      required: ['id', 'status', 'tags', 'site', 'multi', 'already', 'anything'],
      additionalProperties: false,
      properties: {
        id: { type: 'string', pattern: '^a' },
        status: { type: ['string', 'null'], enum: ['on', 'off', null] },
        tags: { type: ['array', 'null'], items: { type: 'string' } },
        site: { type: ['string', 'null'] },
        multi: { type: ['string', 'number', 'null'] },
        already: { type: ['string', 'null'] },
        anything: { anyOf: [{ description: 'untyped' }, { type: 'null' }] },
      },
    });
  });

  it('keeps an enum that already holds null', () => {
    const out = toStrictSchema({
      type: 'object',
      properties: { e: { type: 'string', enum: ['a', null] } },
    });
    expect(out?.['properties']).toEqual({ e: { type: ['string', 'null'], enum: ['a', null] } });
  });

  it('converts anyOf variants', () => {
    expect(toStrictSchema({ anyOf: [{ type: 'string' }, { type: 'number', title: 'x' }] })).toEqual(
      { anyOf: [{ type: 'string' }, { type: 'number' }] },
    );
  });

  it('is null for schemas that cannot be strict', () => {
    expect(toStrictSchema({ oneOf: [{ type: 'string' }] })).toBeNull();
    expect(toStrictSchema({ allOf: [{ type: 'string' }] })).toBeNull();
    expect(toStrictSchema({ anyOf: [true] })).toBeNull();
    expect(toStrictSchema({ anyOf: [{ oneOf: [] }] })).toBeNull();
    expect(toStrictSchema({ type: 'object' })).toBeNull();
    expect(toStrictSchema({ type: 'object', properties: {} })).toBeNull();
    expect(toStrictSchema({ type: 'object', properties: { a: true } })).toBeNull();
    expect(toStrictSchema({ type: 'object', properties: { a: { type: 'object' } } })).toBeNull();
    expect(toStrictSchema({ type: 'array' })).toBeNull();
    expect(toStrictSchema({ type: 'array', items: { oneOf: [] } })).toBeNull();
  });

  it('makes a nullable schema nullable at the top', () => {
    expect(toStrictSchema({ type: 'integer', nullable: true, minimum: 1 })).toEqual({
      type: ['integer', 'null'],
      minimum: 1,
    });
  });
});

describe('dropStrictNulls', () => {
  const schema = {
    type: 'object',
    required: ['req'],
    properties: {
      req: { type: 'string' },
      opt: { type: 'string' },
      clear: { type: 'string', nullable: true },
      nested: { type: 'object', properties: { inner: { type: 'string' } } },
      list: { type: 'array', items: { type: 'object', properties: { x: { type: 'string' } } } },
    },
  };

  it('drops nulls of optional fields only, at every depth', () => {
    expect(
      dropStrictNulls(
        {
          req: null,
          opt: null,
          clear: null,
          extra: null,
          nested: { inner: null },
          list: [{ x: null }, { x: 'a' }],
        },
        schema,
      ),
    ).toEqual({ req: null, clear: null, nested: {}, list: [{}, { x: 'a' }] });
  });

  it('keeps scalars and arrays without an items schema', () => {
    expect(dropStrictNulls('a', schema)).toBe('a');
    expect(dropStrictNulls([null, 1], { type: 'array' })).toEqual([null, 1]);
    expect(dropStrictNulls({ a: 1 }, {})).toEqual({ a: 1 });
  });
});

describe('collectFieldNames', () => {
  it('lists scalar fields at any depth and walks containers', () => {
    const names = collectFieldNames({
      type: 'object',
      properties: {
        name: { type: 'string' },
        count: { type: 'integer' },
        flag: { type: 'boolean' },
        maybe: { type: ['null', 'string'] },
        free: {},
        objNoType: { properties: { inner: { type: 'string' } } },
        arrNoType: { items: { type: 'number' } },
        union: { anyOf: [{ type: 'object' }, { type: 'string' }] },
        unionObj: { oneOf: [{ type: 'object' }, { type: 'array' }] },
        raw: true,
        list: {
          type: 'array',
          items: { type: 'object', properties: { secret: { type: 'string' } } },
        },
        map: { type: 'object', additionalProperties: { type: 'object', properties: { k: {} } } },
        all: { allOf: [{ type: 'object', properties: { deep: { type: 'number' } } }] },
      },
    });
    expect([...names].sort()).toEqual(
      [
        'all',
        'count',
        'deep',
        'free',
        'inner',
        'k',
        'maybe',
        'name',
        'raw',
        'secret',
        'union',
      ].sort(),
    );
  });

  it('walks arrays of schemas and ignores non-objects', () => {
    expect([...collectFieldNames([{ properties: { a: { type: 'string' } } }, 'x', null])]).toEqual([
      'a',
    ]);
  });
});

describe('withoutProperties', () => {
  it('removes properties and their required entries', () => {
    const schema = {
      type: 'object',
      required: ['a', 'b'],
      properties: { a: { type: 'string' }, b: { type: 'string' }, c: { type: 'string' } },
    };
    expect(withoutProperties(schema, ['b', 'c'])).toEqual({
      type: 'object',
      required: ['a'],
      properties: { a: { type: 'string' } },
    });
    expect(withoutProperties(schema, [])).toBe(schema);
    expect(withoutProperties({ type: 'object' }, ['a'])).toEqual({
      type: 'object',
      properties: {},
      required: [],
    });
  });
});

describe('withPropertyEnum', () => {
  it('replaces the id pattern with the allowed values', () => {
    const schema = {
      type: 'object',
      properties: { sessionId: { type: 'string', pattern: '^ses_' }, other: { type: 'number' } },
    };
    expect(withPropertyEnum(schema, 'sessionId', ['ses_1'])).toEqual({
      type: 'object',
      properties: {
        sessionId: { type: 'string', enum: ['ses_1'] },
        other: { type: 'number' },
      },
    });
    expect(schema.properties.sessionId.pattern).toBe('^ses_');
  });

  it('adds a string property when the schema has none', () => {
    expect(withPropertyEnum({}, 'id', ['a', 'b'])).toEqual({
      properties: { id: { type: 'string', enum: ['a', 'b'] } },
    });
  });
});
