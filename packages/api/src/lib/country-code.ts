// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

/**
 * ISO 3166-1 alpha-2 codes from the free-text country of a site ("US",
 * "us", "United States"). Names are matched against the English region
 * names of Intl.DisplayNames, case-insensitively.
 */

const LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';

/** Region codes Intl names that are not countries (unions, pseudo-locales, unknown). */
const NOT_COUNTRIES = new Set(['EU', 'EZ', 'QO', 'UN', 'XA', 'XB', 'ZZ']);

let namesToCodes: Map<string, string> | null = null;

function regionNames(): Intl.DisplayNames {
  return new Intl.DisplayNames(['en'], { type: 'region', fallback: 'none' });
}

/** The current code of a region (`UK` is `GB`, `BU` is `MM`). */
function canonical(code: string): string {
  return Intl.getCanonicalLocales(`und-${code}`)[0]?.slice(4) ?? code;
}

/** A current country code (not an alias, a union or a pseudo-region). */
function isRegionCode(code: string, names: Intl.DisplayNames): boolean {
  return !NOT_COUNTRIES.has(code) && canonical(code) === code && names.of(code) != null;
}

function nameIndex(): Map<string, string> {
  if (namesToCodes != null) return namesToCodes;
  const names = regionNames();
  const index = new Map<string, string>();
  for (const a of LETTERS) {
    for (const b of LETTERS) {
      const code = a + b;
      if (!isRegionCode(code, names)) continue;
      const name = names.of(code);
      if (name != null) index.set(name.toLowerCase(), code);
    }
  }
  namesToCodes = index;
  return index;
}

/** The alpha-2 code of a country code or English country name, or null. */
export function countryToAlpha2(country: string | null | undefined): string | null {
  const value = country?.trim() ?? '';
  if (value === '') return null;
  if (/^[A-Za-z]{2}$/.test(value)) {
    const code = canonical(value.toUpperCase());
    return isRegionCode(code, regionNames()) ? code : null;
  }
  return nameIndex().get(value.toLowerCase()) ?? null;
}
