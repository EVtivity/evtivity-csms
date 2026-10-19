import type { ChargingProfileType } from '../common/ChargingProfileType.js';
import type { CustomDataType } from '../common/CustomDataType.js';

export interface SetChargingProfileRequest {
  customData?: CustomDataType;
  evseId: number;
  chargingProfile: ChargingProfileType;
}
