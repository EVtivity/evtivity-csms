// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

// OCPI 2.2.1 base types shared across both versions

export type OcpiVersion = '2.2.1' | '2.3.0';

export interface OcpiVersionInfo {
  version: OcpiVersion;
  url: string;
}

export interface OcpiVersionDetail {
  version: OcpiVersion;
  endpoints: OcpiEndpoint[];
}

export interface OcpiEndpoint {
  identifier: OcpiModule;
  role: OcpiInterfaceRole;
  url: string;
}

export type OcpiModule =
  | 'credentials'
  | 'locations'
  | 'sessions'
  | 'cdrs'
  | 'tariffs'
  | 'tokens'
  | 'commands'
  | 'chargingprofiles'
  | 'hubclientinfo';

export type OcpiInterfaceRole = 'SENDER' | 'RECEIVER';

export type OcpiRole = 'CPO' | 'EMSP' | 'HUB' | 'NAP' | 'NSP' | 'OTHER' | 'SCSP';

export interface OcpiCredentials {
  token: string;
  url: string;
  roles: OcpiCredentialsRole[];
}

export interface OcpiCredentialsRole {
  role: OcpiRole;
  business_details: OcpiBusinessDetails;
  party_id: string;
  country_code: string;
}

export interface OcpiBusinessDetails {
  name: string;
  website?: string;
  logo?: OcpiImage;
}

export interface OcpiImage {
  url: string;
  thumbnail?: string;
  category: 'CHARGER' | 'ENTRANCE' | 'LOCATION' | 'NETWORK' | 'OPERATOR' | 'OTHER' | 'OWNER';
  type: string;
  width?: number;
  height?: number;
}

// Location types

export interface OcpiLocation {
  country_code: string;
  party_id: string;
  id: string;
  publish: boolean;
  publish_allowed_to?: OcpiPublishTokenType[];
  name?: string;
  address: string;
  city: string;
  postal_code?: string;
  state?: string;
  country: string;
  coordinates: OcpiGeoLocation;
  related_locations?: OcpiAdditionalGeoLocation[];
  parking_type?: OcpiParkingType;
  evses?: OcpiEVSE[];
  directions?: OcpiDisplayText[];
  operator?: OcpiBusinessDetails;
  suboperator?: OcpiBusinessDetails;
  owner?: OcpiBusinessDetails;
  facilities?: OcpiFacility[];
  time_zone: string;
  opening_times?: OcpiHours;
  charging_when_closed?: boolean;
  images?: OcpiImage[];
  energy_mix?: OcpiEnergyMix;
  last_updated: string;
}

export interface OcpiPublishTokenType {
  uid?: string;
  type?: OcpiTokenType;
  visual_number?: string;
  issuer?: string;
  group_id?: string;
}

export interface OcpiGeoLocation {
  latitude: string;
  longitude: string;
}

export interface OcpiAdditionalGeoLocation {
  latitude: string;
  longitude: string;
  name?: OcpiDisplayText;
}

export interface OcpiDisplayText {
  language: string;
  text: string;
}

export type OcpiParkingType =
  | 'ALONG_MOTORWAY'
  | 'PARKING_GARAGE'
  | 'PARKING_LOT'
  | 'ON_DRIVEWAY'
  | 'ON_STREET'
  | 'UNDERGROUND_GARAGE';

export interface OcpiEVSE {
  uid: string;
  evse_id?: string;
  status: OcpiEVSEStatus;
  status_schedule?: OcpiStatusSchedule[];
  capabilities?: OcpiCapability[];
  connectors: OcpiConnector[];
  floor_level?: string;
  coordinates?: OcpiGeoLocation;
  physical_reference?: string;
  directions?: OcpiDisplayText[];
  parking_restrictions?: OcpiParkingRestriction[];
  images?: OcpiImage[];
  last_updated: string;
}

export type OcpiEVSEStatus =
  | 'AVAILABLE'
  | 'BLOCKED'
  | 'CHARGING'
  | 'INOPERATIVE'
  | 'OUTOFORDER'
  | 'PLANNED'
  | 'REMOVED'
  | 'RESERVED'
  | 'UNKNOWN';

export interface OcpiStatusSchedule {
  period_begin: string;
  period_end?: string;
  status: OcpiEVSEStatus;
}

export type OcpiCapability =
  | 'CHARGING_PROFILE_CAPABLE'
  | 'CHARGING_PREFERENCES_CAPABLE'
  | 'CHIP_CARD_SUPPORT'
  | 'CONTACTLESS_CARD_SUPPORT'
  | 'CREDIT_CARD_PAYABLE'
  | 'DEBIT_CARD_PAYABLE'
  | 'PED_TERMINAL'
  | 'REMOTE_START_STOP_CAPABLE'
  | 'RESERVABLE'
  | 'RFID_READER'
  | 'START_SESSION_CONNECTOR_REQUIRED'
  | 'TOKEN_GROUP_CAPABLE'
  | 'UNLOCK_CAPABLE';

export interface OcpiConnector {
  id: string;
  standard: OcpiConnectorType;
  format: OcpiConnectorFormat;
  power_type: OcpiPowerType;
  max_voltage: number;
  max_amperage: number;
  max_electric_power?: number;
  tariff_ids?: string[];
  terms_and_conditions?: string;
  last_updated: string;
}

export type OcpiConnectorType =
  | 'CHADEMO'
  | 'CHAOJI'
  | 'DOMESTIC_A'
  | 'DOMESTIC_B'
  | 'DOMESTIC_C'
  | 'DOMESTIC_D'
  | 'DOMESTIC_E'
  | 'DOMESTIC_F'
  | 'DOMESTIC_G'
  | 'DOMESTIC_H'
  | 'DOMESTIC_I'
  | 'DOMESTIC_J'
  | 'DOMESTIC_K'
  | 'DOMESTIC_L'
  | 'DOMESTIC_M'
  | 'DOMESTIC_N'
  | 'DOMESTIC_O'
  | 'GBT_AC'
  | 'GBT_DC'
  | 'IEC_60309_2_single_16'
  | 'IEC_60309_2_three_16'
  | 'IEC_60309_2_three_32'
  | 'IEC_60309_2_three_64'
  | 'IEC_62196_T1'
  | 'IEC_62196_T1_COMBO'
  | 'IEC_62196_T2'
  | 'IEC_62196_T2_COMBO'
  | 'IEC_62196_T3A'
  | 'IEC_62196_T3C'
  | 'NEMA_5_20'
  | 'NEMA_6_30'
  | 'NEMA_6_50'
  | 'NEMA_10_30'
  | 'NEMA_10_50'
  | 'NEMA_14_30'
  | 'NEMA_14_50'
  | 'PANTOGRAPH_BOTTOM_UP'
  | 'PANTOGRAPH_TOP_DOWN'
  | 'TESLA_R'
  | 'TESLA_S';

export type OcpiConnectorFormat = 'SOCKET' | 'CABLE';

export type OcpiPowerType = 'AC_1_PHASE' | 'AC_2_PHASE' | 'AC_2_PHASE_SPLIT' | 'AC_3_PHASE' | 'DC';

export type OcpiFacility =
  | 'HOTEL'
  | 'RESTAURANT'
  | 'CAFE'
  | 'MALL'
  | 'SUPERMARKET'
  | 'SPORT'
  | 'RECREATION_AREA'
  | 'NATURE'
  | 'MUSEUM'
  | 'BIKE_SHARING'
  | 'BUS_STOP'
  | 'TAXI_STAND'
  | 'TRAM_STOP'
  | 'METRO_STATION'
  | 'TRAIN_STATION'
  | 'AIRPORT'
  | 'PARKING_LOT'
  | 'CARPOOL_PARKING'
  | 'FUEL_STATION'
  | 'WIFI';

export type OcpiParkingRestriction =
  | 'EV_ONLY'
  | 'PLUGGED'
  | 'DISABLED'
  | 'CUSTOMERS'
  | 'MOTORCYCLES';

export interface OcpiHours {
  twentyfourseven: boolean;
  regular_hours?: OcpiRegularHours[];
  exceptional_openings?: OcpiExceptionalPeriod[];
  exceptional_closings?: OcpiExceptionalPeriod[];
}

export interface OcpiRegularHours {
  weekday: number;
  period_begin: string;
  period_end: string;
}

export interface OcpiExceptionalPeriod {
  period_begin: string;
  period_end: string;
}

export interface OcpiEnergyMix {
  is_green_energy: boolean;
  energy_sources?: OcpiEnergySource[];
  environ_impact?: OcpiEnvironmentalImpact[];
  supplier_name?: string;
  energy_product_name?: string;
}

export interface OcpiEnergySource {
  source:
    | 'NUCLEAR'
    | 'GENERAL_FOSSIL'
    | 'COAL'
    | 'GAS'
    | 'GENERAL_GREEN'
    | 'SOLAR'
    | 'WIND'
    | 'WATER';
  percentage: number;
}

export interface OcpiEnvironmentalImpact {
  category: 'NUCLEAR_WASTE' | 'CARBON_DIOXIDE';
  amount: number;
}

// Token types

export type OcpiTokenType = 'AD_HOC_USER' | 'APP_USER' | 'OTHER' | 'RFID';

export type OcpiWhitelist = 'ALWAYS' | 'ALLOWED' | 'ALLOWED_OFFLINE' | 'NEVER';

export interface OcpiToken {
  country_code: string;
  party_id: string;
  uid: string;
  type: OcpiTokenType;
  contract_id: string;
  visual_number?: string;
  issuer: string;
  group_id?: string;
  valid: boolean;
  whitelist: OcpiWhitelist;
  language?: string;
  default_profile_type?: OcpiProfileType;
  energy_contract?: OcpiEnergyContract;
  last_updated: string;
}

export type OcpiProfileType = 'CHEAP' | 'FAST' | 'GREEN' | 'REGULAR';

export interface OcpiEnergyContract {
  supplier_name: string;
  contract_id?: string;
}

export interface OcpiAuthorizationInfo {
  allowed: 'ALLOWED' | 'BLOCKED' | 'EXPIRED' | 'NO_CREDIT' | 'NOT_ALLOWED';
  token: OcpiToken;
  location?: OcpiLocationReference;
  authorization_reference?: string;
  info?: OcpiDisplayText;
}

export interface OcpiLocationReference {
  location_id: string;
  evse_uids?: string[];
}

// Session types

export type OcpiSessionStatus = 'ACTIVE' | 'COMPLETED' | 'INVALID' | 'PENDING' | 'RESERVATION';

export interface OcpiSession {
  country_code: string;
  party_id: string;
  id: string;
  start_date_time: string;
  end_date_time?: string;
  kwh: number;
  cdr_token: OcpiCdrToken;
  auth_method: OcpiAuthMethod;
  authorization_reference?: string;
  location_id: string;
  evse_uid: string;
  connector_id: string;
  meter_id?: string;
  currency: string;
  charging_periods?: OcpiChargingPeriod[];
  total_cost?: OcpiPrice;
  status: OcpiSessionStatus;
  last_updated: string;
}

export interface OcpiCdrToken {
  country_code: string;
  party_id: string;
  uid: string;
  type: OcpiTokenType;
  contract_id: string;
}

export type OcpiAuthMethod = 'AUTH_REQUEST' | 'COMMAND' | 'WHITELIST';

export interface OcpiChargingPeriod {
  start_date_time: string;
  dimensions: OcpiCdrDimension[];
  tariff_id?: string;
}

export interface OcpiCdrDimension {
  type: OcpiCdrDimensionType;
  volume: number;
}

export type OcpiCdrDimensionType =
  | 'CURRENT'
  | 'ENERGY'
  | 'ENERGY_EXPORT'
  | 'ENERGY_IMPORT'
  | 'MAX_CURRENT'
  | 'MIN_CURRENT'
  | 'MAX_POWER'
  | 'MIN_POWER'
  | 'PARKING_TIME'
  | 'POWER'
  | 'RESERVATION_TIME'
  | 'STATE_OF_CHARGE'
  | 'TIME';

export interface OcpiPrice {
  excl_vat: number;
  incl_vat?: number;
}

// CDR types

export interface OcpiCdr {
  country_code: string;
  party_id: string;
  id: string;
  start_date_time: string;
  end_date_time: string;
  session_id?: string;
  cdr_token: OcpiCdrToken;
  auth_method: OcpiAuthMethod;
  authorization_reference?: string;
  cdr_location: OcpiCdrLocation;
  meter_id?: string;
  currency: string;
  tariffs?: OcpiTariff[];
  charging_periods: OcpiChargingPeriod[];
  signed_data?: OcpiSignedData;
  total_cost: OcpiPrice;
  total_fixed_cost?: OcpiPrice;
  total_energy: number;
  total_energy_cost?: OcpiPrice;
  total_time: number;
  total_time_cost?: OcpiPrice;
  total_parking_time?: number;
  total_parking_cost?: OcpiPrice;
  total_reservation_cost?: OcpiPrice;
  remark?: string;
  invoice_reference_id?: string;
  credit?: boolean;
  credit_reference_id?: string;
  last_updated: string;
}

export interface OcpiCdrLocation {
  id: string;
  name?: string;
  address: string;
  city: string;
  postal_code?: string;
  state?: string;
  country: string;
  coordinates: OcpiGeoLocation;
  evse_uid: string;
  evse_id?: string;
  connector_id: string;
  connector_standard: OcpiConnectorType;
  connector_format: OcpiConnectorFormat;
  connector_power_type: OcpiPowerType;
}

export interface OcpiSignedData {
  encoding_method: string;
  encoding_method_version?: number;
  public_key?: string;
  signed_values: OcpiSignedValue[];
  url?: string;
}

export interface OcpiSignedValue {
  nature: string;
  plain_data: string;
  signed_data: string;
}

// Tariff types

export interface OcpiTariff {
  country_code: string;
  party_id: string;
  id: string;
  currency: string;
  type?: OcpiTariffType;
  tariff_alt_text?: OcpiDisplayText[];
  tariff_alt_url?: string;
  min_price?: OcpiPrice;
  max_price?: OcpiPrice;
  elements: OcpiTariffElement[];
  start_date_time?: string;
  end_date_time?: string;
  energy_mix?: OcpiEnergyMix;
  last_updated: string;
}

export type OcpiTariffType =
  | 'AD_HOC_PAYMENT'
  | 'PROFILE_CHEAP'
  | 'PROFILE_FAST'
  | 'PROFILE_GREEN'
  | 'REGULAR';

export interface OcpiTariffElement {
  price_components: OcpiPriceComponent[];
  restrictions?: OcpiTariffRestrictions;
}

export interface OcpiPriceComponent {
  type: OcpiTariffDimensionType;
  price: number;
  vat?: number;
  step_size: number;
}

export type OcpiTariffDimensionType = 'ENERGY' | 'FLAT' | 'PARKING_TIME' | 'TIME';

export interface OcpiTariffRestrictions {
  start_time?: string;
  end_time?: string;
  start_date?: string;
  end_date?: string;
  min_kwh?: number;
  max_kwh?: number;
  min_current?: number;
  max_current?: number;
  min_power?: number;
  max_power?: number;
  min_duration?: number;
  max_duration?: number;
  day_of_week?: number[];
  reservation?: 'RESERVATION' | 'RESERVATION_EXPIRES';
}

// Command types

export type OcpiCommandType =
  | 'CANCEL_RESERVATION'
  | 'RESERVE_NOW'
  | 'START_SESSION'
  | 'STOP_SESSION'
  | 'UNLOCK_CONNECTOR';

export type OcpiCommandResponseType = 'NOT_SUPPORTED' | 'REJECTED' | 'ACCEPTED' | 'UNKNOWN_SESSION';

export interface OcpiCommandResponse {
  result: OcpiCommandResponseType;
  timeout: number;
}

export type OcpiCommandResultType =
  | 'ACCEPTED'
  | 'CANCELED_RESERVATION'
  | 'EVSE_OCCUPIED'
  | 'EVSE_INOPERATIVE'
  | 'FAILED'
  | 'NOT_SUPPORTED'
  | 'REJECTED'
  | 'TIMEOUT'
  | 'UNKNOWN_RESERVATION';

export interface OcpiCommandResult {
  result: OcpiCommandResultType;
  message?: OcpiDisplayText[];
}

export interface OcpiStartSession {
  response_url: string;
  token: OcpiToken;
  location_id: string;
  evse_uid?: string;
  connector_id?: string;
  authorization_reference?: string;
}

export interface OcpiStopSession {
  response_url: string;
  session_id: string;
}

export interface OcpiReserveNow {
  response_url: string;
  token: OcpiToken;
  expiry_date: string;
  reservation_id: string;
  location_id: string;
  evse_uid?: string;
  authorization_reference?: string;
}

export interface OcpiCancelReservation {
  response_url: string;
  reservation_id: string;
}

export interface OcpiUnlockConnector {
  response_url: string;
  location_id: string;
  evse_uid: string;
  connector_id: string;
}

// Charging Profile types

export interface OcpiChargingProfile {
  start_date_time?: string;
  duration?: number;
  charging_rate_unit: 'W' | 'A';
  min_charging_rate?: number;
  charging_profile_period: OcpiChargingProfilePeriod[];
}

export interface OcpiChargingProfilePeriod {
  start_period: number;
  limit: number;
}

// Hub Client Info types

export interface OcpiClientInfo {
  party_id: string;
  country_code: string;
  role: OcpiRole;
  status: 'CONNECTED' | 'OFFLINE' | 'PLANNED' | 'SUSPENDED';
  last_updated: string;
}
