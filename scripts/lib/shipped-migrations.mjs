// Shipped migration guard. packages/database/shipped-migrations.json maps each
// stable release to the migration files it first shipped and their SHA-256.
// The runner decides pending by hash, so a changed shipped file runs again on
// every install that applied it; these checks catch the change before it ships.

/**
 * Problems with the shipped files: a mapped file that is missing or whose bytes
 * changed, a mapped file the journal does not list, a file listed twice, and an
 * unmapped journal entry ordered before a shipped one (only the files of the
 * release being built may be unmapped, and they come last).
 *
 * @param {Record<string, Record<string, string>>} shipped version -> tag -> sha256
 * @param {{ entries: { idx: number; tag: string }[] }} journal
 * @param {(tag: string) => string | null} hashOf the current sha256 of a file, null when missing
 * @returns {string[]}
 */
export function shippedMigrationProblems(shipped, journal, hashOf) {
  const problems = [];
  const releaseOf = new Map();
  for (const [version, files] of Object.entries(shipped)) {
    for (const [tag, hash] of Object.entries(files)) {
      if (releaseOf.has(tag)) {
        problems.push(`${tag}: listed in ${releaseOf.get(tag)} and ${version}`);
        continue;
      }
      releaseOf.set(tag, version);
      const current = hashOf(tag);
      if (current == null) {
        problems.push(`${tag} (shipped in ${version}): the file is missing`);
      } else if (current !== hash) {
        problems.push(
          `${tag} (shipped in ${version}): its bytes changed. A shipped migration is frozen: ` +
            `revert it and put the change in the release file of the version being built`,
        );
      }
    }
  }
  const journalTags = new Set(journal.entries.map((e) => e.tag));
  for (const [tag, version] of releaseOf) {
    if (!journalTags.has(tag)) problems.push(`${tag} (shipped in ${version}): not in the journal`);
  }
  let lastShippedIdx = -1;
  for (const entry of journal.entries) {
    if (releaseOf.has(entry.tag)) lastShippedIdx = Math.max(lastShippedIdx, entry.idx);
  }
  for (const entry of journal.entries) {
    if (!releaseOf.has(entry.tag) && entry.idx < lastShippedIdx) {
      problems.push(`${entry.tag}: not shipped but ordered before a shipped migration`);
    }
  }
  return problems;
}

/**
 * Adds every journal file no release lists yet to `version`, with its current
 * hash. Throws when the version is already listed or no file is new.
 *
 * @param {Record<string, Record<string, string>>} shipped
 * @param {{ entries: { idx: number; tag: string }[] }} journal
 * @param {(tag: string) => string | null} hashOf
 * @param {string} version a stable tag such as v0.1.52
 * @returns {Record<string, Record<string, string>>}
 */
export function recordShippedMigrations(shipped, journal, hashOf, version) {
  if (!/^v\d+\.\d+\.\d+$/.test(version)) throw new Error(`${version} is not a stable tag`);
  if (Object.hasOwn(shipped, version)) throw new Error(`${version} is already recorded`);
  const listed = new Set(Object.values(shipped).flatMap((files) => Object.keys(files)));
  const added = {};
  for (const entry of journal.entries) {
    if (listed.has(entry.tag)) continue;
    const hash = hashOf(entry.tag);
    if (hash == null) throw new Error(`${entry.tag}: the file is missing`);
    added[entry.tag] = hash;
  }
  if (Object.keys(added).length === 0) throw new Error(`no new migration file for ${version}`);
  return { ...shipped, [version]: added };
}
