// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

// CSS-side connector type enum (mirrors the css_connector_type Postgres enum
// on css_evses). GBT, Tesla, and NACS aren't representable yet; consumers
// that need them fall back to ac_type2.
export type CssConnectorType = 'ac_type2' | 'ac_type1' | 'dc_ccs2' | 'dc_ccs1' | 'dc_chademo';

export const CSS_CONNECTOR_TYPES: readonly CssConnectorType[] = [
  'ac_type2',
  'ac_type1',
  'dc_ccs2',
  'dc_ccs1',
  'dc_chademo',
];

export function mapConnectorTypeToCss(t: string | null | undefined): CssConnectorType {
  switch (t) {
    case 'Type2':
      return 'ac_type2';
    case 'Type1':
      return 'ac_type1';
    case 'CCS2':
      return 'dc_ccs2';
    case 'CCS1':
      return 'dc_ccs1';
    case 'CHAdeMO':
      return 'dc_chademo';
    default:
      return 'ac_type2';
  }
}

export function mapCssToOcppConnectorType(t: CssConnectorType): string {
  switch (t) {
    case 'ac_type2':
      return 'cType2';
    case 'ac_type1':
      return 'cType1';
    case 'dc_ccs2':
      return 'cCCS2';
    case 'dc_ccs1':
      return 'cCCS1';
    case 'dc_chademo':
      return 'cChaoJi';
  }
}

export function randomCssConnectorType(): CssConnectorType {
  const idx = Math.floor(Math.random() * CSS_CONNECTOR_TYPES.length);
  return CSS_CONNECTOR_TYPES[idx] ?? 'ac_type2';
}
