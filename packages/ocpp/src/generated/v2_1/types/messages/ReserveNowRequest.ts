import type { CustomDataType } from '../common/CustomDataType.js';
import type { IdTokenType } from '../common/IdTokenType.js';

export interface ReserveNowRequest {
  id: number;
  expiryDateTime: string;
  connectorType?: string;
  idToken: IdTokenType;
  evseId?: number;
  groupIdToken?: IdTokenType;
  customData?: CustomDataType;
}
