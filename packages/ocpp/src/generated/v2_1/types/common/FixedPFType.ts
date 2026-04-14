import type { CustomDataType } from './CustomDataType.js';

export interface FixedPFType {
  priority: number;
  displacement: number;
  excitation: boolean;
  startTime?: string;
  duration?: number;
  customData?: CustomDataType;
}
