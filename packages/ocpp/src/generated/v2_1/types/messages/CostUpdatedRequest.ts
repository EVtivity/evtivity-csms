import type { CustomDataType } from '../common/CustomDataType.js';

export interface CostUpdatedRequest {
  totalCost: number;
  transactionId: string;
  customData?: CustomDataType;
}
