import type { CustomDataType } from './CustomDataType.js';

export interface FreqDroopType {
  priority: number;
  overFreq: number;
  underFreq: number;
  overDroop: number;
  underDroop: number;
  responseTime: number;
  startTime?: string;
  duration?: number;
  customData?: CustomDataType;
}
