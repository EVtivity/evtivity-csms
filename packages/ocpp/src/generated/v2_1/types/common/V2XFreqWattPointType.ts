import type { CustomDataType } from './CustomDataType.js';

export interface V2XFreqWattPointType {
  frequency: number;
  power: number;
  customData?: CustomDataType;
}
