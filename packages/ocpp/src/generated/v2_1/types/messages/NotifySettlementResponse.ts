import type { CustomDataType } from '../common/CustomDataType.js';

export interface NotifySettlementResponse {
  receiptUrl?: string;
  receiptId?: string;
  customData?: CustomDataType;
}
