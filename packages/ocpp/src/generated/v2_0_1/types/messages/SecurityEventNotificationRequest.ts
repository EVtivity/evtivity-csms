import type { CustomDataType } from '../common/CustomDataType.js';

export interface SecurityEventNotificationRequest {
  customData?: CustomDataType;
  type: string;
  timestamp: string;
  techInfo?: string;
}
