// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect } from 'vitest';
import type { TFunction } from 'i18next';
import en from '../../i18n/locales/en.json';
import {
  AUDIT_ACTIONS,
  AUDIT_ACTORS,
  AUDIT_ENTITY_TYPES,
  auditActionLabel,
  auditEntityLabel,
  humanizeAuditCode,
} from '../audit-labels';

// The audit schema is the source of truth for actions, entity types and actors.
const SCHEMA = Object.values(
  import.meta.glob<string>('../../../../database/src/schema/audit.ts', {
    query: '?raw',
    import: 'default',
    eager: true,
  }),
)[0];

function enumValues(source: string): Map<string, string[]> {
  const enums = new Map<string, string[]>();
  for (const match of source.matchAll(/pgEnum\(\s*'(\w+)'\s*,\s*\[([^\]]*)\]/g)) {
    const name = match[1] ?? '';
    const values = [...(match[2] ?? '').matchAll(/'([^']+)'/g)].map((m) => m[1] ?? '');
    enums.set(name, values);
  }
  return enums;
}

function auditTableKeys(source: string): string[] {
  const block = /export const AUDIT_TABLES = \{([^}]*)\}/.exec(source)?.[1] ?? '';
  return [...block.matchAll(/^\s*(\w+):/gm)].map((m) => m[1] ?? '');
}

const enums = enumValues(SCHEMA ?? '');
const schemaActions = new Set(
  [...enums.entries()]
    .filter(([name]) => name.endsWith('_audit_action'))
    .flatMap(([, values]) => values),
);
const enAudit = en.audit as unknown as {
  actions: Record<string, string>;
  entities: Record<string, string>;
  actors: Record<string, string>;
};

describe('audit labels', () => {
  it('reads the audit schema', () => {
    expect(SCHEMA).toBeTypeOf('string');
    expect(schemaActions.size).toBeGreaterThan(50);
  });

  it('has an en label for every audit action enum value', () => {
    const missing = [...schemaActions].filter((a) => typeof enAudit.actions[a] !== 'string');
    expect(missing).toEqual([]);
  });

  it('offers every audit action enum value in the Audit page filter', () => {
    const listed = new Set<string>(AUDIT_ACTIONS);
    expect([...schemaActions].filter((a) => !listed.has(a))).toEqual([]);
    expect(AUDIT_ACTIONS.filter((a) => !schemaActions.has(a))).toEqual([]);
  });

  it('lists every audited entity type with an en label', () => {
    const tables = auditTableKeys(SCHEMA ?? '');
    expect(tables.length).toBeGreaterThan(20);
    expect([...AUDIT_ENTITY_TYPES].sort()).toEqual([...tables].sort());
    expect(tables.filter((e) => typeof enAudit.entities[e] !== 'string')).toEqual([]);
  });

  it('has an en label for every actor', () => {
    expect([...AUDIT_ACTORS]).toEqual(enums.get('audit_actor'));
    expect(AUDIT_ACTORS.filter((a) => typeof enAudit.actors[a] !== 'string')).toEqual([]);
  });

  it('humanizes an unknown code', () => {
    expect(humanizeAuditCode('invoice_sent')).toBe('Invoice sent');
    expect(humanizeAuditCode('some-new_action')).toBe('Some new action');
    expect(humanizeAuditCode('')).toBe('');
  });

  it('falls back to the humanized code when the key is missing', () => {
    const t = ((key: string, opts?: { defaultValue?: string }) =>
      key === 'audit.actions.created' ? 'Created' : (opts?.defaultValue ?? key)) as TFunction;
    expect(auditActionLabel(t, 'created')).toBe('Created');
    expect(auditActionLabel(t, 'brand_new_thing')).toBe('Brand new thing');
    expect(auditEntityLabel(t, 'new_entity')).toBe('New entity');
  });
});
