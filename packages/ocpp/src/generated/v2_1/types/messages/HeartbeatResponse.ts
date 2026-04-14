import type { CustomDataType } from '../common/CustomDataType.js';

export interface HeartbeatResponse {
  currentTime: string;
  customData?: CustomDataType;
}
