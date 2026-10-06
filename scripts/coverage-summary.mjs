#!/usr/bin/env node
/**
 * Print a Vitest json-summary coverage file as a Markdown table, for the
 * GitHub Actions job summary. Reports only: coverage never fails the build.
 * With --badge <file>, also writes a shields.io endpoint badge for line coverage.
 *
 * Usage: node scripts/coverage-summary.mjs coverage/coverage-summary.json [--badge coverage.json]
 */
import { readFileSync, writeFileSync } from 'node:fs';

const args = process.argv.slice(2);
const badgeIndex = args.indexOf('--badge');
const badgeFile = badgeIndex === -1 ? null : args[badgeIndex + 1];
const positional = args.filter(
  (_, i) => badgeIndex === -1 || (i !== badgeIndex && i !== badgeIndex + 1),
);
const file = positional[0] ?? 'coverage/coverage-summary.json';
const { total } = JSON.parse(readFileSync(file, 'utf8'));

const metrics = [
  ['Statements', total.statements],
  ['Branches', total.branches],
  ['Functions', total.functions],
  ['Lines', total.lines],
];

const rows = metrics.map(
  ([name, m]) => `| ${name} | ${m.pct.toFixed(2)}% | ${m.covered} / ${m.total} |`,
);

console.log(
  [
    '## Unit test coverage',
    '',
    '| Metric | Coverage | Covered |',
    '| --- | --- | --- |',
    ...rows,
    '',
    'The full HTML report is in the `coverage-report` artifact.',
  ].join('\n'),
);

if (badgeFile != null) {
  const pct = total.lines.pct;
  const color = pct >= 80 ? 'brightgreen' : pct >= 60 ? 'yellow' : 'orange';
  const badge = { schemaVersion: 1, label: 'Coverage', message: `${pct.toFixed(0)}%`, color };
  writeFileSync(badgeFile, `${JSON.stringify(badge)}\n`);
}
