import type { CustomDataType } from '../common/CustomDataType.js';

import type { EnergyTransferModeEnum } from '../../enums/EnergyTransferModeEnum.js';

export interface ACChargingParametersType {
  customData?: CustomDataType;
  energyAmount: number;
  evMinCurrent: number;
  evMaxCurrent: number;
  evMaxVoltage: number;
}

export interface ChargingNeedsType {
  customData?: CustomDataType;
  acChargingParameters?: ACChargingParametersType;
  dcChargingParameters?: DCChargingParametersType;
  requestedEnergyTransfer: EnergyTransferModeEnum;
  departureTime?: string;
}

export interface DCChargingParametersType {
  customData?: CustomDataType;
  evMaxCurrent: number;
  evMaxVoltage: number;
  energyAmount?: number;
  evMaxPower?: number;
  stateOfCharge?: number;
  evEnergyCapacity?: number;
  fullSoC?: number;
  bulkSoC?: number;
}

export interface NotifyEVChargingNeedsRequest {
  customData?: CustomDataType;
  maxScheduleTuples?: number;
  chargingNeeds: ChargingNeedsType;
  evseId: number;
}
