import type { CustomDataType } from '../common/CustomDataType.js';

export interface PullDynamicScheduleUpdateRequest {
  chargingProfileId: number;
  customData?: CustomDataType;
}
