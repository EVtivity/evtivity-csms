import type { ClearChargingProfileChargingProfilePurposeEnum } from '../../enums/ClearChargingProfileChargingProfilePurposeEnum.js';

export interface ClearChargingProfile {
  id?: number;
  connectorId?: number;
  chargingProfilePurpose?: ClearChargingProfileChargingProfilePurposeEnum;
  stackLevel?: number;
}
