import type { ChargingProfileType } from '../common/ChargingProfileType.js';
import type { CustomDataType } from '../common/CustomDataType.js';

import type { ChargingLimitSourceEnum } from '../../enums/ChargingLimitSourceEnum.js';

export interface ReportChargingProfilesRequest {
  customData?: CustomDataType;
  requestId: number;
  chargingLimitSource: ChargingLimitSourceEnum;
  chargingProfile: ChargingProfileType[];
  tbc?: boolean;
  evseId: number;
}
