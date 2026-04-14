import type { CustomDataType } from './CustomDataType.js';

export interface LimitAtSoCType {
  soc: number;
  limit: number;
  customData?: CustomDataType;
}
