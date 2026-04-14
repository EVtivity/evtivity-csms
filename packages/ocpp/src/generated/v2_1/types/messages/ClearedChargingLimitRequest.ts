import type { CustomDataType } from '../common/CustomDataType.js';

export interface ClearedChargingLimitRequest {
  chargingLimitSource: string;
  evseId?: number;
  customData?: CustomDataType;
}
