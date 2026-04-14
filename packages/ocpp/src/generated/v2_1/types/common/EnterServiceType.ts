import type { CustomDataType } from './CustomDataType.js';

export interface EnterServiceType {
  priority: number;
  highVoltage: number;
  lowVoltage: number;
  highFreq: number;
  lowFreq: number;
  delay?: number;
  randomDelay?: number;
  rampRate?: number;
  customData?: CustomDataType;
}
