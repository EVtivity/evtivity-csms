import type { CustomDataType } from '../common/CustomDataType.js';
import type { PeriodicEventStreamParamsType } from '../common/PeriodicEventStreamParamsType.js';

export interface AdjustPeriodicEventStreamRequest {
  id: number;
  params: PeriodicEventStreamParamsType;
  customData?: CustomDataType;
}
