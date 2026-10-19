import type { CustomDataType } from '../common/CustomDataType.js';
import type { IdTokenInfoType } from '../common/IdTokenInfoType.js';
import type { MessageContentType } from '../common/MessageContentType.js';

export interface TransactionEventResponse {
  customData?: CustomDataType;
  totalCost?: number;
  chargingPriority?: number;
  idTokenInfo?: IdTokenInfoType;
  updatedPersonalMessage?: MessageContentType;
}
