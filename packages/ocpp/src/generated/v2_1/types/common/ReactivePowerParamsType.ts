import type { CustomDataType } from './CustomDataType.js';

export interface ReactivePowerParamsType {
  vRef?: number;
  autonomousVRefEnable?: boolean;
  autonomousVRefTimeConstant?: number;
  customData?: CustomDataType;
}
