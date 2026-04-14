import type { CustomDataType } from '../common/CustomDataType.js';

export interface AFRRSignalRequest {
  timestamp: string;
  signal: number;
  customData?: CustomDataType;
}
