import type { IdTagInfoType } from '../common/IdTagInfoType.js';

export interface StartTransactionResponse {
  idTagInfo: IdTagInfoType;
  transactionId: number;
}
