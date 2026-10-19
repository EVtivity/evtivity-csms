import type { CustomDataType } from '../common/CustomDataType.js';

import type { ChargingProfilePurposeEnum } from '../../enums/ChargingProfilePurposeEnum.js';

export interface ClearChargingProfileType {
  customData?: CustomDataType;
  evseId?: number;
  chargingProfilePurpose?: ChargingProfilePurposeEnum;
  stackLevel?: number;
}

export interface ClearChargingProfileRequest {
  customData?: CustomDataType;
  chargingProfileId?: number;
  chargingProfileCriteria?: ClearChargingProfileType;
}
