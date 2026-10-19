import type { CustomDataType } from '../common/CustomDataType.js';

export interface HeartbeatResponse {
  customData?: CustomDataType;
  currentTime: string;
}
