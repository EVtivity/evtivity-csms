import type { CustomDataType } from '../common/CustomDataType.js';

export interface NotifyWebPaymentStartedRequest {
  evseId: number;
  timeout: number;
  customData?: CustomDataType;
}
