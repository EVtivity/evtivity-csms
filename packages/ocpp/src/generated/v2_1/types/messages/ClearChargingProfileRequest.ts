import type { CustomDataType } from '../common/CustomDataType.js';

import type { ChargingProfilePurposeEnum } from '../../enums/ChargingProfilePurposeEnum.js';

export interface ClearChargingProfileType {
  evseId?: number;
  chargingProfilePurpose?: ChargingProfilePurposeEnum;
  stackLevel?: number;
  customData?: CustomDataType;
}

export interface ClearChargingProfileRequest {
  chargingProfileId?: number;
  chargingProfileCriteria?: ClearChargingProfileType;
  customData?: CustomDataType;
}
