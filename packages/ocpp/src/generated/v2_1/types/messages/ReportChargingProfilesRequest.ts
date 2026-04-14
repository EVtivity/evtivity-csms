import type { ChargingProfileType } from '../common/ChargingProfileType.js';
import type { CustomDataType } from '../common/CustomDataType.js';

export interface ReportChargingProfilesRequest {
  requestId: number;
  chargingLimitSource: string;
  chargingProfile: ChargingProfileType[];
  tbc?: boolean;
  evseId: number;
  customData?: CustomDataType;
}
