import type { CustomDataType } from './CustomDataType.js';

export interface PeriodicEventStreamParamsType {
  interval?: number;
  values?: number;
  customData?: CustomDataType;
}
