import type { ChargingProfileType } from '../common/ChargingProfileType.js';
import type { CustomDataType } from '../common/CustomDataType.js';

export interface SetChargingProfileRequest {
  evseId: number;
  chargingProfile: ChargingProfileType;
  customData?: CustomDataType;
}
