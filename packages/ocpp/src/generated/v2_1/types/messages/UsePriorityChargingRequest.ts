import type { CustomDataType } from '../common/CustomDataType.js';

export interface UsePriorityChargingRequest {
  transactionId: string;
  activate: boolean;
  customData?: CustomDataType;
}
