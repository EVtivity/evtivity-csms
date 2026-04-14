import type { AddressType } from '../common/AddressType.js';
import type { CustomDataType } from '../common/CustomDataType.js';

import type { PaymentStatusEnum } from '../../enums/PaymentStatusEnum.js';

export interface NotifySettlementRequest {
  transactionId?: string;
  pspRef: string;
  status: PaymentStatusEnum;
  statusInfo?: string;
  settlementAmount: number;
  settlementTime: string;
  receiptId?: string;
  receiptUrl?: string;
  vatCompany?: AddressType;
  vatNumber?: string;
  customData?: CustomDataType;
}
