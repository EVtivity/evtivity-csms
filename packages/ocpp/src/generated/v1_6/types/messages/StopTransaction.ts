import type { SampledValueType } from '../common/SampledValueType.js';

import type { StopTransactionReasonEnum } from '../../enums/StopTransactionReasonEnum.js';

export interface TransactionDataType {
  timestamp: string;
  sampledValue: SampledValueType[];
}

export interface StopTransaction {
  idTag?: string;
  meterStop: number;
  timestamp: string;
  transactionId: number;
  reason?: StopTransactionReasonEnum;
  transactionData?: TransactionDataType[];
}
