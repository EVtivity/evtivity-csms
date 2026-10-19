import type { CustomDataType } from '../common/CustomDataType.js';

export interface CostUpdatedRequest {
  customData?: CustomDataType;
  totalCost: number;
  transactionId: string;
}
