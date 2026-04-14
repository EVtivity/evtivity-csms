import type { CustomDataType } from '../common/CustomDataType.js';

import type { ChargingProfilePurposeEnum } from '../../enums/ChargingProfilePurposeEnum.js';

export interface ChargingProfileCriterionType {
  chargingProfilePurpose?: ChargingProfilePurposeEnum;
  stackLevel?: number;
  chargingProfileId?: number[];
  chargingLimitSource?: string[];
  customData?: CustomDataType;
}

export interface GetChargingProfilesRequest {
  requestId: number;
  evseId?: number;
  chargingProfile: ChargingProfileCriterionType;
  customData?: CustomDataType;
}
