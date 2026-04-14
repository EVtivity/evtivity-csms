// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { db } from './config.js';
import { carbonIntensityFactors } from './schema/carbon.js';

interface CarbonFactor {
  regionCode: string;
  regionName: string;
  countryCode: string;
  carbonIntensityKgPerKwh: string;
  source: string;
}

const EPA_EGRID_FACTORS: CarbonFactor[] = [
  {
    regionCode: 'AKGD',
    regionName: 'ASCC Alaska Grid',
    countryCode: 'US',
    carbonIntensityKgPerKwh: '0.437',
    source: 'eGRID-2023',
  },
  {
    regionCode: 'AKMS',
    regionName: 'ASCC Miscellaneous',
    countryCode: 'US',
    carbonIntensityKgPerKwh: '0.227',
    source: 'eGRID-2023',
  },
  {
    regionCode: 'AZNM',
    regionName: 'WECC Southwest',
    countryCode: 'US',
    carbonIntensityKgPerKwh: '0.370',
    source: 'eGRID-2023',
  },
  {
    regionCode: 'CAMX',
    regionName: 'WECC California',
    countryCode: 'US',
    carbonIntensityKgPerKwh: '0.220',
    source: 'eGRID-2023',
  },
  {
    regionCode: 'ERCT',
    regionName: 'ERCOT All',
    countryCode: 'US',
    carbonIntensityKgPerKwh: '0.373',
    source: 'eGRID-2023',
  },
  {
    regionCode: 'FRCC',
    regionName: 'FRCC All',
    countryCode: 'US',
    carbonIntensityKgPerKwh: '0.378',
    source: 'eGRID-2023',
  },
  {
    regionCode: 'HIMS',
    regionName: 'HICC Miscellaneous',
    countryCode: 'US',
    carbonIntensityKgPerKwh: '0.531',
    source: 'eGRID-2023',
  },
  {
    regionCode: 'HIOA',
    regionName: 'HICC Oahu',
    countryCode: 'US',
    carbonIntensityKgPerKwh: '0.663',
    source: 'eGRID-2023',
  },
  {
    regionCode: 'MROE',
    regionName: 'MRO East',
    countryCode: 'US',
    carbonIntensityKgPerKwh: '0.558',
    source: 'eGRID-2023',
  },
  {
    regionCode: 'MROW',
    regionName: 'MRO West',
    countryCode: 'US',
    carbonIntensityKgPerKwh: '0.412',
    source: 'eGRID-2023',
  },
  {
    regionCode: 'NEWE',
    regionName: 'NPCC New England',
    countryCode: 'US',
    carbonIntensityKgPerKwh: '0.214',
    source: 'eGRID-2023',
  },
  {
    regionCode: 'NWPP',
    regionName: 'WECC Northwest',
    countryCode: 'US',
    carbonIntensityKgPerKwh: '0.268',
    source: 'eGRID-2023',
  },
  {
    regionCode: 'NYCW',
    regionName: 'NPCC NYC/Westchester',
    countryCode: 'US',
    carbonIntensityKgPerKwh: '0.228',
    source: 'eGRID-2023',
  },
  {
    regionCode: 'NYLI',
    regionName: 'NPCC Long Island',
    countryCode: 'US',
    carbonIntensityKgPerKwh: '0.466',
    source: 'eGRID-2023',
  },
  {
    regionCode: 'NYUP',
    regionName: 'NPCC Upstate NY',
    countryCode: 'US',
    carbonIntensityKgPerKwh: '0.105',
    source: 'eGRID-2023',
  },
  {
    regionCode: 'PRMS',
    regionName: 'Puerto Rico',
    countryCode: 'US',
    carbonIntensityKgPerKwh: '0.757',
    source: 'eGRID-2023',
  },
  {
    regionCode: 'RFCE',
    regionName: 'RFC East',
    countryCode: 'US',
    carbonIntensityKgPerKwh: '0.302',
    source: 'eGRID-2023',
  },
  {
    regionCode: 'RFCM',
    regionName: 'RFC Michigan',
    countryCode: 'US',
    carbonIntensityKgPerKwh: '0.440',
    source: 'eGRID-2023',
  },
  {
    regionCode: 'RFCW',
    regionName: 'RFC West',
    countryCode: 'US',
    carbonIntensityKgPerKwh: '0.454',
    source: 'eGRID-2023',
  },
  {
    regionCode: 'RMPA',
    regionName: 'WECC Rockies',
    countryCode: 'US',
    carbonIntensityKgPerKwh: '0.529',
    source: 'eGRID-2023',
  },
  {
    regionCode: 'SPNO',
    regionName: 'SPP North',
    countryCode: 'US',
    carbonIntensityKgPerKwh: '0.466',
    source: 'eGRID-2023',
  },
  {
    regionCode: 'SPSO',
    regionName: 'SPP South',
    countryCode: 'US',
    carbonIntensityKgPerKwh: '0.424',
    source: 'eGRID-2023',
  },
  {
    regionCode: 'SRMV',
    regionName: 'SERC Mississippi Valley',
    countryCode: 'US',
    carbonIntensityKgPerKwh: '0.345',
    source: 'eGRID-2023',
  },
  {
    regionCode: 'SRMW',
    regionName: 'SERC Midwest',
    countryCode: 'US',
    carbonIntensityKgPerKwh: '0.637',
    source: 'eGRID-2023',
  },
  {
    regionCode: 'SRSO',
    regionName: 'SERC South',
    countryCode: 'US',
    carbonIntensityKgPerKwh: '0.390',
    source: 'eGRID-2023',
  },
  {
    regionCode: 'SRTV',
    regionName: 'SERC Tennessee Valley',
    countryCode: 'US',
    carbonIntensityKgPerKwh: '0.359',
    source: 'eGRID-2023',
  },
  {
    regionCode: 'SRVC',
    regionName: 'SERC Virginia/Carolina',
    countryCode: 'US',
    carbonIntensityKgPerKwh: '0.289',
    source: 'eGRID-2023',
  },
];

const EMBER_COUNTRY_FACTORS: CarbonFactor[] = [
  {
    regionCode: 'GB',
    regionName: 'United Kingdom',
    countryCode: 'GB',
    carbonIntensityKgPerKwh: '0.207',
    source: 'Ember-2024',
  },
  {
    regionCode: 'DE',
    regionName: 'Germany',
    countryCode: 'DE',
    carbonIntensityKgPerKwh: '0.364',
    source: 'Ember-2024',
  },
  {
    regionCode: 'FR',
    regionName: 'France',
    countryCode: 'FR',
    carbonIntensityKgPerKwh: '0.056',
    source: 'Ember-2024',
  },
  {
    regionCode: 'NO',
    regionName: 'Norway',
    countryCode: 'NO',
    carbonIntensityKgPerKwh: '0.008',
    source: 'Ember-2024',
  },
  {
    regionCode: 'NL',
    regionName: 'Netherlands',
    countryCode: 'NL',
    carbonIntensityKgPerKwh: '0.328',
    source: 'Ember-2024',
  },
  {
    regionCode: 'SE',
    regionName: 'Sweden',
    countryCode: 'SE',
    carbonIntensityKgPerKwh: '0.012',
    source: 'Ember-2024',
  },
  {
    regionCode: 'DK',
    regionName: 'Denmark',
    countryCode: 'DK',
    carbonIntensityKgPerKwh: '0.112',
    source: 'Ember-2024',
  },
  {
    regionCode: 'ES',
    regionName: 'Spain',
    countryCode: 'ES',
    carbonIntensityKgPerKwh: '0.150',
    source: 'Ember-2024',
  },
  {
    regionCode: 'IT',
    regionName: 'Italy',
    countryCode: 'IT',
    carbonIntensityKgPerKwh: '0.261',
    source: 'Ember-2024',
  },
  {
    regionCode: 'PT',
    regionName: 'Portugal',
    countryCode: 'PT',
    carbonIntensityKgPerKwh: '0.131',
    source: 'Ember-2024',
  },
  {
    regionCode: 'AT',
    regionName: 'Austria',
    countryCode: 'AT',
    carbonIntensityKgPerKwh: '0.089',
    source: 'Ember-2024',
  },
  {
    regionCode: 'BE',
    regionName: 'Belgium',
    countryCode: 'BE',
    carbonIntensityKgPerKwh: '0.139',
    source: 'Ember-2024',
  },
  {
    regionCode: 'CH',
    regionName: 'Switzerland',
    countryCode: 'CH',
    carbonIntensityKgPerKwh: '0.016',
    source: 'Ember-2024',
  },
  {
    regionCode: 'IE',
    regionName: 'Ireland',
    countryCode: 'IE',
    carbonIntensityKgPerKwh: '0.268',
    source: 'Ember-2024',
  },
  {
    regionCode: 'PL',
    regionName: 'Poland',
    countryCode: 'PL',
    carbonIntensityKgPerKwh: '0.635',
    source: 'Ember-2024',
  },
  {
    regionCode: 'FI',
    regionName: 'Finland',
    countryCode: 'FI',
    carbonIntensityKgPerKwh: '0.068',
    source: 'Ember-2024',
  },
  {
    regionCode: 'CA',
    regionName: 'Canada',
    countryCode: 'CA',
    carbonIntensityKgPerKwh: '0.120',
    source: 'Ember-2024',
  },
  {
    regionCode: 'AU',
    regionName: 'Australia',
    countryCode: 'AU',
    carbonIntensityKgPerKwh: '0.530',
    source: 'Ember-2024',
  },
  {
    regionCode: 'JP',
    regionName: 'Japan',
    countryCode: 'JP',
    carbonIntensityKgPerKwh: '0.462',
    source: 'Ember-2024',
  },
  {
    regionCode: 'KR',
    regionName: 'South Korea',
    countryCode: 'KR',
    carbonIntensityKgPerKwh: '0.415',
    source: 'Ember-2024',
  },
  {
    regionCode: 'CN',
    regionName: 'China',
    countryCode: 'CN',
    carbonIntensityKgPerKwh: '0.537',
    source: 'Ember-2024',
  },
  {
    regionCode: 'IN',
    regionName: 'India',
    countryCode: 'IN',
    carbonIntensityKgPerKwh: '0.632',
    source: 'Ember-2024',
  },
  {
    regionCode: 'BR',
    regionName: 'Brazil',
    countryCode: 'BR',
    carbonIntensityKgPerKwh: '0.074',
    source: 'Ember-2024',
  },
  {
    regionCode: 'MX',
    regionName: 'Mexico',
    countryCode: 'MX',
    carbonIntensityKgPerKwh: '0.408',
    source: 'Ember-2024',
  },
  {
    regionCode: 'NZ',
    regionName: 'New Zealand',
    countryCode: 'NZ',
    carbonIntensityKgPerKwh: '0.082',
    source: 'Ember-2024',
  },
  {
    regionCode: 'IL',
    regionName: 'Israel',
    countryCode: 'IL',
    carbonIntensityKgPerKwh: '0.480',
    source: 'Ember-2024',
  },
  {
    regionCode: 'SG',
    regionName: 'Singapore',
    countryCode: 'SG',
    carbonIntensityKgPerKwh: '0.408',
    source: 'Ember-2024',
  },
  {
    regionCode: 'AE',
    regionName: 'United Arab Emirates',
    countryCode: 'AE',
    carbonIntensityKgPerKwh: '0.410',
    source: 'Ember-2024',
  },
  {
    regionCode: 'TH',
    regionName: 'Thailand',
    countryCode: 'TH',
    carbonIntensityKgPerKwh: '0.466',
    source: 'Ember-2024',
  },
  {
    regionCode: 'ZA',
    regionName: 'South Africa',
    countryCode: 'ZA',
    carbonIntensityKgPerKwh: '0.709',
    source: 'Ember-2024',
  },
  {
    regionCode: 'CL',
    regionName: 'Chile',
    countryCode: 'CL',
    carbonIntensityKgPerKwh: '0.282',
    source: 'Ember-2024',
  },
  {
    regionCode: 'CO',
    regionName: 'Colombia',
    countryCode: 'CO',
    carbonIntensityKgPerKwh: '0.136',
    source: 'Ember-2024',
  },
  {
    regionCode: 'IS',
    regionName: 'Iceland',
    countryCode: 'IS',
    carbonIntensityKgPerKwh: '0.001',
    source: 'Ember-2024',
  },
];

const ALL_FACTORS = [...EPA_EGRID_FACTORS, ...EMBER_COUNTRY_FACTORS];

export async function seedCarbonIntensityFactors(): Promise<number> {
  let inserted = 0;
  for (const factor of ALL_FACTORS) {
    await db
      .insert(carbonIntensityFactors)
      .values(factor)
      .onConflictDoUpdate({
        target: carbonIntensityFactors.regionCode,
        set: {
          regionName: factor.regionName,
          countryCode: factor.countryCode,
          carbonIntensityKgPerKwh: factor.carbonIntensityKgPerKwh,
          source: factor.source,
          updatedAt: new Date(),
        },
      });
    inserted++;
  }
  return inserted;
}
