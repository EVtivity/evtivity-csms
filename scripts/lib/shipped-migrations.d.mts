// Types for shipped-migrations.mjs, which plain node runs without a build step.

export type ShippedMigrations = Record<string, Record<string, string>>;
export interface MigrationJournal {
  entries: { idx: number; tag: string }[];
}

export function shippedMigrationProblems(
  shipped: ShippedMigrations,
  journal: MigrationJournal,
  hashOf: (tag: string) => string | null,
): string[];
export function recordShippedMigrations(
  shipped: ShippedMigrations,
  journal: MigrationJournal,
  hashOf: (tag: string) => string | null,
  version: string,
): ShippedMigrations;
