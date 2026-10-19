import type { CustomDataType } from '../common/CustomDataType.js';

import type { ChargingLimitSourceEnum } from '../../enums/ChargingLimitSourceEnum.js';
import type { ChargingProfilePurposeEnum } from '../../enums/ChargingProfilePurposeEnum.js';

export interface ChargingProfileCriterionType {
  customData?: CustomDataType;
  chargingProfilePurpose?: ChargingProfilePurposeEnum;
  stackLevel?: number;
  chargingProfileId?: number[];
  chargingLimitSource?: ChargingLimitSourceEnum[];
}

export interface GetChargingProfilesRequest {
  customData?: CustomDataType;
  requestId: number;
  evseId?: number;
  chargingProfile: ChargingProfileCriterionType;
}
