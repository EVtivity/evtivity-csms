// Types for migration-files.mjs, which plain node runs without a build step.

export interface MigrationSql {
  unsafe(query: string): PromiseLike<unknown>;
  begin(fn: (tx: MigrationSql) => Promise<unknown>): Promise<unknown>;
  (strings: TemplateStringsArray, ...values: unknown[]): PromiseLike<unknown>;
}

export const NO_TRANSACTION_MARKER: string;
export const STATEMENT_BREAKPOINT: string;
export function migrationHash(contents: string): string;
export function isNoTransaction(contents: string): boolean;
export function splitStatements(contents: string): string[];
export function migrationFileProblems(contents: string): string[];
export function applyMigrationFile(
  sql: MigrationSql,
  file: { contents: string; hash: string; when: number },
): Promise<void>;
export function lockMigrations(sql: MigrationSql): Promise<void>;
