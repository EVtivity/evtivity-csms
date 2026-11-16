// Types for migration-baseline.mjs, which plain node runs without a build step.

export interface BaselineRuntimeValue {
  table: string;
  column: string;
  rule: 'default' | 'now';
}

export interface BaselineManifest {
  baseline: { tag: string; hash: string; when: number };
  release: string;
  upgradeFrom: string;
  marker: { tag: string; hash: string } | null;
  lastReplaced: { tag: string; hash: string; when: number };
  replaced: Record<string, string>;
  pgDumpMajor: number;
  runtimeValues: BaselineRuntimeValue[];
}

export type BaselineAction =
  | { kind: 'none' }
  | { kind: 'run' }
  | { kind: 'mark' }
  | { kind: 'refuse'; message: string };

export const BASELINE_MANIFEST: string;
export function readBaselineManifest(folder: string): BaselineManifest | null;
export function baselineTagFor(foldBefore: string): string;
export function parseVersion(tag: string): [number, number, number] | null;
export function compareVersions(a: string, b: string): -1 | 0 | 1;
export function foldBeforeFor(tag: string, shipped: Record<string, unknown>): string;
export function squashRequiredFor(tag: string, shipped: Record<string, unknown>): string | null;
export function baselineAction(
  manifest: BaselineManifest | null,
  appliedHashes: Set<string>,
): BaselineAction;
export function reconcileBaseline(
  sql: unknown,
  manifest: BaselineManifest | null,
  appliedHashes: Set<string>,
): Promise<BaselineAction>;
export function baselineManifestProblems(
  manifest: BaselineManifest,
  journal: { entries: { idx: number; tag: string; when?: number }[] },
  hashOf: (tag: string) => string | null,
): string[];
