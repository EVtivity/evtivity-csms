import type { CustomDataType } from '../common/CustomDataType.js';

import type { ControlModeEnum } from '../../enums/ControlModeEnum.js';
import type { DERControlEnum } from '../../enums/DERControlEnum.js';
import type { EnergyTransferModeEnum } from '../../enums/EnergyTransferModeEnum.js';
import type { IslandingDetectionEnum } from '../../enums/IslandingDetectionEnum.js';
import type { MobilityNeedsModeEnum } from '../../enums/MobilityNeedsModeEnum.js';

export interface ACChargingParametersType {
  energyAmount: number;
  evMinCurrent: number;
  evMaxCurrent: number;
  evMaxVoltage: number;
  customData?: CustomDataType;
}

export interface ChargingNeedsType {
  acChargingParameters?: ACChargingParametersType;
  derChargingParameters?: DERChargingParametersType;
  evEnergyOffer?: EVEnergyOfferType;
  requestedEnergyTransfer: EnergyTransferModeEnum;
  dcChargingParameters?: DCChargingParametersType;
  v2xChargingParameters?: V2XChargingParametersType;
  availableEnergyTransfer?: EnergyTransferModeEnum[];
  controlMode?: ControlModeEnum;
  mobilityNeedsMode?: MobilityNeedsModeEnum;
  departureTime?: string;
  customData?: CustomDataType;
}

export interface DCChargingParametersType {
  evMaxCurrent: number;
  evMaxVoltage: number;
  evMaxPower?: number;
  evEnergyCapacity?: number;
  energyAmount?: number;
  stateOfCharge?: number;
  fullSoC?: number;
  bulkSoC?: number;
  customData?: CustomDataType;
}

export interface DERChargingParametersType {
  evSupportedDERControl?: DERControlEnum[];
  evOverExcitedMaxDischargePower?: number;
  evOverExcitedPowerFactor?: number;
  evUnderExcitedMaxDischargePower?: number;
  evUnderExcitedPowerFactor?: number;
  maxApparentPower?: number;
  maxChargeApparentPower?: number;
  maxChargeApparentPower_L2?: number;
  maxChargeApparentPower_L3?: number;
  maxDischargeApparentPower?: number;
  maxDischargeApparentPower_L2?: number;
  maxDischargeApparentPower_L3?: number;
  maxChargeReactivePower?: number;
  maxChargeReactivePower_L2?: number;
  maxChargeReactivePower_L3?: number;
  minChargeReactivePower?: number;
  minChargeReactivePower_L2?: number;
  minChargeReactivePower_L3?: number;
  maxDischargeReactivePower?: number;
  maxDischargeReactivePower_L2?: number;
  maxDischargeReactivePower_L3?: number;
  minDischargeReactivePower?: number;
  minDischargeReactivePower_L2?: number;
  minDischargeReactivePower_L3?: number;
  nominalVoltage?: number;
  nominalVoltageOffset?: number;
  maxNominalVoltage?: number;
  minNominalVoltage?: number;
  evInverterManufacturer?: string;
  evInverterModel?: string;
  evInverterSerialNumber?: string;
  evInverterSwVersion?: string;
  evInverterHwVersion?: string;
  evIslandingDetectionMethod?: IslandingDetectionEnum[];
  evIslandingTripTime?: number;
  evMaximumLevel1DCInjection?: number;
  evDurationLevel1DCInjection?: number;
  evMaximumLevel2DCInjection?: number;
  evDurationLevel2DCInjection?: number;
  evReactiveSusceptance?: number;
  evSessionTotalDischargeEnergyAvailable?: number;
  customData?: CustomDataType;
}

export interface EVAbsolutePriceScheduleEntryType {
  duration: number;
  evPriceRule: EVPriceRuleType[];
  customData?: CustomDataType;
}

export interface EVAbsolutePriceScheduleType {
  timeAnchor: string;
  currency: string;
  evAbsolutePriceScheduleEntries: EVAbsolutePriceScheduleEntryType[];
  priceAlgorithm: string;
  customData?: CustomDataType;
}

export interface EVEnergyOfferType {
  evAbsolutePriceSchedule?: EVAbsolutePriceScheduleType;
  evPowerSchedule: EVPowerScheduleType;
  customData?: CustomDataType;
}

export interface EVPowerScheduleEntryType {
  duration: number;
  power: number;
  customData?: CustomDataType;
}

export interface EVPowerScheduleType {
  evPowerScheduleEntries: EVPowerScheduleEntryType[];
  timeAnchor: string;
  customData?: CustomDataType;
}

export interface EVPriceRuleType {
  energyFee: number;
  powerRangeStart: number;
  customData?: CustomDataType;
}

export interface V2XChargingParametersType {
  minChargePower?: number;
  minChargePower_L2?: number;
  minChargePower_L3?: number;
  maxChargePower?: number;
  maxChargePower_L2?: number;
  maxChargePower_L3?: number;
  minDischargePower?: number;
  minDischargePower_L2?: number;
  minDischargePower_L3?: number;
  maxDischargePower?: number;
  maxDischargePower_L2?: number;
  maxDischargePower_L3?: number;
  minChargeCurrent?: number;
  maxChargeCurrent?: number;
  minDischargeCurrent?: number;
  maxDischargeCurrent?: number;
  minVoltage?: number;
  maxVoltage?: number;
  evTargetEnergyRequest?: number;
  evMinEnergyRequest?: number;
  evMaxEnergyRequest?: number;
  evMinV2XEnergyRequest?: number;
  evMaxV2XEnergyRequest?: number;
  targetSoC?: number;
  customData?: CustomDataType;
}

export interface NotifyEVChargingNeedsRequest {
  evseId: number;
  maxScheduleTuples?: number;
  chargingNeeds: ChargingNeedsType;
  timestamp?: string;
  customData?: CustomDataType;
}
