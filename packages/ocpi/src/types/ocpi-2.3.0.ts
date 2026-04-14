// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

// OCPI 2.3.0 extensions
// Open enums, AFIR compliance fields, parking, accessibility, NA tax, hub_party_id

import type {
  OcpiCredentialsRole,
  OcpiLocation,
  OcpiEVSE,
  OcpiConnector,
  OcpiTariff,
} from './ocpi.js';

export type Ocpi230Version = '2.3.0';

export const OCPI_230_MODULES = [
  'credentials',
  'locations',
  'sessions',
  'cdrs',
  'tariffs',
  'tokens',
  'commands',
  'chargingprofiles',
  'hubclientinfo',
] as const;

// 2.3.0 uses open enums: unknown values must be accepted and passed through
// All enum fields in 2.3.0 can accept any string value, not just the defined ones

// Extended credentials role with hub_party_id
export interface Ocpi230CredentialsRole extends OcpiCredentialsRole {
  hub_party_id?: string;
}

// Extended location with AFIR and accessibility fields
// Use Omit to allow widening enum types to string (open enums in 2.3.0)
export interface Ocpi230Location extends Omit<OcpiLocation, 'publish_allowed_to' | 'parking_type'> {
  publish_allowed_to?: Ocpi230PublishTokenType[];
  parking_type?: string; // Open enum in 2.3.0
  accessibility?: Ocpi230Accessibility;
  charging_station_id?: string; // AFIR: unique station identifier
  physical_reference?: string;
}

export interface Ocpi230PublishTokenType {
  uid?: string;
  type?: string; // Open enum
  visual_number?: string;
  issuer?: string;
  group_id?: string;
}

export interface Ocpi230Accessibility {
  free_of_charge: boolean;
  wheelchair_accessible?: boolean;
  floor_level?: string;
  physical_restriction?: string; // Open enum
}

// Extended EVSE with additional 2.3.0 fields
export interface Ocpi230EVSE extends Omit<
  OcpiEVSE,
  'status' | 'capabilities' | 'parking_restrictions'
> {
  status: string; // Open enum
  capabilities?: string[]; // Open enum
  parking_restrictions?: string[]; // Open enum
}

// Extended connector with 2.3.0 fields
export interface Ocpi230Connector extends Omit<
  OcpiConnector,
  'standard' | 'format' | 'power_type'
> {
  standard: string; // Open enum
  format: string; // Open enum
  power_type: string; // Open enum
}

// Extended tariff with NA tax support
export interface Ocpi230Tariff extends Omit<OcpiTariff, 'type'> {
  type?: string; // Open enum
  tax_included?: boolean;
  country_tax?: Ocpi230CountryTax[];
}

export interface Ocpi230CountryTax {
  country: string;
  state?: string;
  tax_rate: number;
  tax_name?: string;
}
