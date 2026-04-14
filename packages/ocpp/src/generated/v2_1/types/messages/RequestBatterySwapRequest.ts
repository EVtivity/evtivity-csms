import type { CustomDataType } from '../common/CustomDataType.js';
import type { IdTokenType } from '../common/IdTokenType.js';

export interface RequestBatterySwapRequest {
  idToken: IdTokenType;
  requestId: number;
  customData?: CustomDataType;
}
