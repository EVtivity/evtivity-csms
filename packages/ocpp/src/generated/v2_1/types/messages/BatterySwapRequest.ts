import type { CustomDataType } from '../common/CustomDataType.js';
import type { IdTokenType } from '../common/IdTokenType.js';

import type { BatterySwapEventEnum } from '../../enums/BatterySwapEventEnum.js';

export interface BatteryDataType {
  evseId: number;
  serialNumber: string;
  soC: number;
  soH: number;
  productionDate?: string;
  vendorInfo?: string;
  customData?: CustomDataType;
}

export interface BatterySwapRequest {
  batteryData: BatteryDataType[];
  eventType: BatterySwapEventEnum;
  idToken: IdTokenType;
  requestId: number;
  customData?: CustomDataType;
}
