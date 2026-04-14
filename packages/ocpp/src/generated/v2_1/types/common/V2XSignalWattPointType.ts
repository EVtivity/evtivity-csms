import type { CustomDataType } from './CustomDataType.js';

export interface V2XSignalWattPointType {
  signal: number;
  power: number;
  customData?: CustomDataType;
}
