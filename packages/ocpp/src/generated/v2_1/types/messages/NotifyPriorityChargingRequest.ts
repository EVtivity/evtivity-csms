import type { CustomDataType } from '../common/CustomDataType.js';

export interface NotifyPriorityChargingRequest {
  transactionId: string;
  activated: boolean;
  customData?: CustomDataType;
}
