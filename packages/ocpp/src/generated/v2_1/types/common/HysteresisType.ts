import type { CustomDataType } from './CustomDataType.js';

export interface HysteresisType {
  hysteresisHigh?: number;
  hysteresisLow?: number;
  hysteresisDelay?: number;
  hysteresisGradient?: number;
  customData?: CustomDataType;
}
