// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

// ISO 3166-1 country codes. Sites store the country as the operator typed it
// (an alpha-2 or alpha-3 code, or an English name); OCPI requires the alpha-3
// code (Location.country, CdrLocation.country), so every reader converts with
// `toIso3166Alpha3` and the site API refuses a value it cannot convert.

const ALPHA2_TO_ALPHA3_PAIRS =
  'AD:AND AE:ARE AF:AFG AG:ATG AI:AIA AL:ALB AM:ARM AO:AGO AQ:ATA AR:ARG AS:ASM AT:AUT AU:AUS ' +
  'AW:ABW AX:ALA AZ:AZE BA:BIH BB:BRB BD:BGD BE:BEL BF:BFA BG:BGR BH:BHR BI:BDI BJ:BEN BL:BLM ' +
  'BM:BMU BN:BRN BO:BOL BQ:BES BR:BRA BS:BHS BT:BTN BV:BVT BW:BWA BY:BLR BZ:BLZ CA:CAN CC:CCK ' +
  'CD:COD CF:CAF CG:COG CH:CHE CI:CIV CK:COK CL:CHL CM:CMR CN:CHN CO:COL CR:CRI CU:CUB CV:CPV ' +
  'CW:CUW CX:CXR CY:CYP CZ:CZE DE:DEU DJ:DJI DK:DNK DM:DMA DO:DOM DZ:DZA EC:ECU EE:EST EG:EGY ' +
  'EH:ESH ER:ERI ES:ESP ET:ETH FI:FIN FJ:FJI FK:FLK FM:FSM FO:FRO FR:FRA GA:GAB GB:GBR GD:GRD ' +
  'GE:GEO GF:GUF GG:GGY GH:GHA GI:GIB GL:GRL GM:GMB GN:GIN GP:GLP GQ:GNQ GR:GRC GS:SGS GT:GTM ' +
  'GU:GUM GW:GNB GY:GUY HK:HKG HM:HMD HN:HND HR:HRV HT:HTI HU:HUN ID:IDN IE:IRL IL:ISR IM:IMN ' +
  'IN:IND IO:IOT IQ:IRQ IR:IRN IS:ISL IT:ITA JE:JEY JM:JAM JO:JOR JP:JPN KE:KEN KG:KGZ KH:KHM ' +
  'KI:KIR KM:COM KN:KNA KP:PRK KR:KOR KW:KWT KY:CYM KZ:KAZ LA:LAO LB:LBN LC:LCA LI:LIE LK:LKA ' +
  'LR:LBR LS:LSO LT:LTU LU:LUX LV:LVA LY:LBY MA:MAR MC:MCO MD:MDA ME:MNE MF:MAF MG:MDG MH:MHL ' +
  'MK:MKD ML:MLI MM:MMR MN:MNG MO:MAC MP:MNP MQ:MTQ MR:MRT MS:MSR MT:MLT MU:MUS MV:MDV MW:MWI ' +
  'MX:MEX MY:MYS MZ:MOZ NA:NAM NC:NCL NE:NER NF:NFK NG:NGA NI:NIC NL:NLD NO:NOR NP:NPL NR:NRU ' +
  'NU:NIU NZ:NZL OM:OMN PA:PAN PE:PER PF:PYF PG:PNG PH:PHL PK:PAK PL:POL PM:SPM PN:PCN PR:PRI ' +
  'PS:PSE PT:PRT PW:PLW PY:PRY QA:QAT RE:REU RO:ROU RS:SRB RU:RUS RW:RWA SA:SAU SB:SLB SC:SYC ' +
  'SD:SDN SE:SWE SG:SGP SH:SHN SI:SVN SJ:SJM SK:SVK SL:SLE SM:SMR SN:SEN SO:SOM SR:SUR SS:SSD ' +
  'ST:STP SV:SLV SX:SXM SY:SYR SZ:SWZ TC:TCA TD:TCD TF:ATF TG:TGO TH:THA TJ:TJK TK:TKL TL:TLS ' +
  'TM:TKM TN:TUN TO:TON TR:TUR TT:TTO TV:TUV TW:TWN TZ:TZA UA:UKR UG:UGA UM:UMI US:USA UY:URY ' +
  'UZ:UZB VA:VAT VC:VCT VE:VEN VG:VGB VI:VIR VN:VNM VU:VUT WF:WLF WS:WSM YE:YEM YT:MYT ZA:ZAF ' +
  'ZM:ZMB ZW:ZWE';

/** ISO 3166-1 alpha-2 code to alpha-3 code, every officially assigned code. */
export const ISO3166_ALPHA2_TO_ALPHA3: ReadonlyMap<string, string> = new Map(
  ALPHA2_TO_ALPHA3_PAIRS.split(' ').map((pair) => {
    const [a2, a3] = pair.split(':');
    return [a2 ?? '', a3 ?? ''];
  }),
);

const ALPHA3_CODES: ReadonlySet<string> = new Set(ISO3166_ALPHA2_TO_ALPHA3.values());

// Common names that are not the English display name of their code.
const NAME_ALIASES: Record<string, string> = {
  usa: 'USA',
  us: 'USA',
  unitedstatesofamerica: 'USA',
  america: 'USA',
  uk: 'GBR',
  greatbritain: 'GBR',
  england: 'GBR',
  scotland: 'GBR',
  wales: 'GBR',
  northernireland: 'GBR',
  korea: 'KOR',
  republicofkorea: 'KOR',
  russianfederation: 'RUS',
  holland: 'NLD',
  thenetherlands: 'NLD',
  czechia: 'CZE',
  czechrepublic: 'CZE',
  turkey: 'TUR',
  turkiye: 'TUR',
  ivorycoast: 'CIV',
  vietnam: 'VNM',
  macedonia: 'MKD',
  swaziland: 'SWZ',
  burma: 'MMR',
  hongkong: 'HKG',
  macau: 'MAC',
  macao: 'MAC',
  taiwan: 'TWN',
};

function nameKey(value: string): string {
  return value
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z]/g, '');
}

let namesToAlpha3: Map<string, string> | null = null;

function englishNames(): Map<string, string> {
  if (namesToAlpha3 != null) return namesToAlpha3;
  const map = new Map<string, string>();
  let display: Intl.DisplayNames | null = null;
  try {
    display = new Intl.DisplayNames(['en'], { type: 'region' });
  } catch {
    // fail-open: a runtime without ICU region names still converts codes and aliases.
    display = null;
  }
  for (const [a2, a3] of ISO3166_ALPHA2_TO_ALPHA3) {
    const name = display?.of(a2);
    if (name != null && name !== a2) map.set(nameKey(name), a3);
  }
  for (const [alias, a3] of Object.entries(NAME_ALIASES)) map.set(alias, a3);
  namesToAlpha3 = map;
  return map;
}

/**
 * The ISO 3166-1 alpha-3 code for a stored country: an alpha-3 or alpha-2
 * code (any case) or an English country name. Null when the value is empty
 * or not a known country.
 */
export function toIso3166Alpha3(value: string | null | undefined): string | null {
  if (value == null) return null;
  const trimmed = value.trim();
  if (trimmed === '') return null;
  const upper = trimmed.toUpperCase();
  if (/^[A-Z]{3}$/.test(upper) && ALPHA3_CODES.has(upper)) return upper;
  if (/^[A-Z]{2}$/.test(upper)) {
    const a3 = ISO3166_ALPHA2_TO_ALPHA3.get(upper === 'UK' ? 'GB' : upper);
    if (a3 != null) return a3;
  }
  return englishNames().get(nameKey(trimmed)) ?? null;
}

/** True when `toIso3166Alpha3` converts the value to a country code. */
export function isKnownCountry(value: string): boolean {
  return toIso3166Alpha3(value) != null;
}
