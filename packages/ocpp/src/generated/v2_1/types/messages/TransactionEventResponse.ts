import type { CustomDataType } from '../common/CustomDataType.js';
import type { IdTokenInfoType } from '../common/IdTokenInfoType.js';
import type { MessageContentType } from '../common/MessageContentType.js';
import type { TransactionLimitType } from '../common/TransactionLimitType.js';

export interface TransactionEventResponse {
  totalCost?: number;
  chargingPriority?: number;
  idTokenInfo?: IdTokenInfoType;
  transactionLimit?: TransactionLimitType;
  updatedPersonalMessage?: MessageContentType;
  updatedPersonalMessageExtra?: MessageContentType[];
  customData?: CustomDataType;
}
