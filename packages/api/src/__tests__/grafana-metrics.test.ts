// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

// The Grafana dashboards and alert rules query only metrics the API
// registers, and every metric the API registers for operators is on a
// dashboard or an alert. Runs without a stack: the metric names come from the
// prom-client registry, the queries from the provisioned files.

import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { register } from '../plugins/metrics.js';

const GRAFANA = fileURLToPath(new URL('../../../../prometheus/grafana/', import.meta.url));
const DASHBOARDS = join(GRAFANA, 'dashboards');
const RULES = join(GRAFANA, 'provisioning/alerting/rules.yml');

/** PromQL words that are not metric names (operators, modifiers, constants). */
const PROMQL_WORDS = new Set([
  'and',
  'or',
  'unless',
  'bool',
  'offset',
  'by',
  'without',
  'on',
  'ignoring',
  'group_left',
  'group_right',
  'inf',
  'nan',
]);

/**
 * Metrics the API registers that no dashboard or alert needs to show, each
 * with the reason. Default Node.js process metrics are not listed: they are
 * covered when one of each family is shown, so only API metrics are checked.
 */
const NOT_ON_A_DASHBOARD = new Map<string, string>([]);

/** prom-client default metrics it registers on Linux only (the API images run Linux). */
const LINUX_ONLY_DEFAULT_METRICS = [
  'process_open_fds',
  'process_max_fds',
  'process_virtual_memory_bytes',
  'process_heap_bytes',
];

/** The metric names a PromQL expression reads. */
function promqlMetricNames(expr: string): string[] {
  const stripped = expr
    .replace(/"(?:[^"\\]|\\.)*"/g, ' ')
    .replace(/'(?:[^'\\]|\\.)*'/g, ' ')
    .replace(/\{[^}]*\}/g, ' ')
    .replace(/\[[^\]]*\]/g, ' ')
    .replace(/\b(?:by|without|on|ignoring|group_left|group_right)\s*\([^)]*\)/g, ' ')
    .replace(/\$\{[^}]*\}|\$\w+/g, ' ')
    .replace(/\b\d+(?:\.\d+)?(?:e[+-]?\d+)?\b/gi, ' ');
  const names = new Set<string>();
  for (const match of stripped.matchAll(/([a-zA-Z_:][\w:]*)(\s*\()?/g)) {
    const word = match[1] ?? '';
    if (match[2] != null) continue; // a function call
    if (PROMQL_WORDS.has(word.toLowerCase())) continue;
    names.add(word);
  }
  return [...names];
}

interface Query {
  source: string;
  expr: string;
}

function isLoki(ds: unknown): boolean {
  if (ds == null || typeof ds !== 'object') return false;
  const d = ds as { type?: unknown; uid?: unknown };
  return d.type === 'loki' || d.uid === 'loki';
}

function dashboardQueries(): Query[] {
  const out: Query[] = [];
  const walk = (node: unknown, source: string, panelLoki: boolean): void => {
    if (Array.isArray(node)) {
      for (const n of node) walk(n, source, panelLoki);
      return;
    }
    if (node == null || typeof node !== 'object') return;
    const obj = node as Record<string, unknown>;
    const loki = 'datasource' in obj ? isLoki(obj['datasource']) : panelLoki;
    const title = typeof obj['title'] === 'string' ? `${source} > ${obj['title']}` : source;
    if (typeof obj['expr'] === 'string' && !loki) out.push({ source: title, expr: obj['expr'] });
    for (const [key, value] of Object.entries(obj)) {
      if (key !== 'expr') walk(value, title, loki);
    }
  };
  for (const file of readdirSync(DASHBOARDS).filter((f) => f.endsWith('.json'))) {
    walk(JSON.parse(readFileSync(join(DASHBOARDS, file), 'utf8')), file, false);
  }
  return out;
}

interface RuleFile {
  groups: {
    rules: {
      title: string;
      data: { datasourceUid: string; model: { expr?: string } }[];
    }[];
  }[];
}

function ruleQueries(): Query[] {
  const file = parse(readFileSync(RULES, 'utf8')) as RuleFile;
  const out: Query[] = [];
  for (const group of file.groups) {
    for (const rule of group.rules) {
      for (const d of rule.data) {
        if (d.datasourceUid === 'prometheus' && typeof d.model.expr === 'string') {
          out.push({ source: `rules.yml > ${rule.title}`, expr: d.model.expr });
        }
      }
    }
  }
  return out;
}

/** Every series name the registry exports (histograms add _bucket, _sum and _count). */
async function exportedNames(): Promise<{ all: Set<string>; api: string[] }> {
  const all = new Set<string>(LINUX_ONLY_DEFAULT_METRICS);
  const api: string[] = [];
  for (const metric of await register.getMetricsAsJSON()) {
    all.add(metric.name);
    const type = String(metric.type);
    if (type === 'histogram' || type === 'summary') {
      for (const suffix of ['_bucket', '_sum', '_count']) all.add(`${metric.name}${suffix}`);
    }
    if (!/^(?:process_|nodejs_)/.test(metric.name)) api.push(metric.name);
  }
  return { all, api };
}

describe('promqlMetricNames', () => {
  it('reads metric names and skips functions, labels, ranges and words', () => {
    expect(
      promqlMetricNames(
        'histogram_quantile(0.95, sum(rate(http_request_duration_seconds_bucket{route="/x"}[5m])) by (le))',
      ),
    ).toEqual(['http_request_duration_seconds_bucket']);
    expect(
      promqlMetricNames(
        'max(depot_systems_enabled) - sum(depot_system_connections) or vector(0) > bool 1e3',
      ),
    ).toEqual(['depot_systems_enabled', 'depot_system_connections']);
    expect(promqlMetricNames('sum without (instance) (rate(x_total[$__rate_interval]))')).toEqual([
      'x_total',
    ]);
  });
});

describe('Grafana dashboards and alert rules', () => {
  it('query only metrics the API registers', async () => {
    const { all } = await exportedNames();
    const queries = [...dashboardQueries(), ...ruleQueries()];
    expect(queries.length).toBeGreaterThan(50);
    const missing = queries.flatMap((q) =>
      promqlMetricNames(q.expr)
        .filter((name) => !all.has(name))
        .map((name) => `${q.source}: ${name}`),
    );
    expect(missing).toEqual([]);
  });

  it('show every metric the API registers for operators', async () => {
    const { api } = await exportedNames();
    const shown = new Set(
      [...dashboardQueries(), ...ruleQueries()].flatMap((q) => promqlMetricNames(q.expr)),
    );
    const isShown = (name: string): boolean =>
      shown.has(name) || ['_bucket', '_sum', '_count'].some((s) => shown.has(`${name}${s}`));
    const hidden = api.filter((name) => !isShown(name) && !NOT_ON_A_DASHBOARD.has(name));
    expect(hidden).toEqual([]);
    const listedButShown = [...NOT_ON_A_DASHBOARD.keys()].filter(isShown);
    expect(listedButShown).toEqual([]);
  });

  it('are valid JSON and YAML with unique panel ids and alert uids', () => {
    for (const file of readdirSync(DASHBOARDS).filter((f) => f.endsWith('.json'))) {
      const ids: number[] = [];
      const walk = (panels: { id: number; panels?: unknown[] }[]): void => {
        for (const p of panels) {
          ids.push(p.id);
          if (Array.isArray(p.panels)) walk(p.panels as { id: number }[]);
        }
      };
      const dashboard = JSON.parse(readFileSync(join(DASHBOARDS, file), 'utf8')) as {
        panels: { id: number }[];
      };
      walk(dashboard.panels);
      expect(new Set(ids).size, `${file} panel ids`).toBe(ids.length);
    }
    const file = parse(readFileSync(RULES, 'utf8')) as {
      groups: { rules: { uid: string }[] }[];
    };
    const uids = file.groups.flatMap((g) => g.rules.map((r) => r.uid));
    expect(new Set(uids).size).toBe(uids.length);
  });
});
