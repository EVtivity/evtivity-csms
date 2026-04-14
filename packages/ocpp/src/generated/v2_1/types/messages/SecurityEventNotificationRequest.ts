import type { CustomDataType } from '../common/CustomDataType.js';

export interface SecurityEventNotificationRequest {
  type: string;
  timestamp: string;
  techInfo?: string;
  customData?: CustomDataType;
}
