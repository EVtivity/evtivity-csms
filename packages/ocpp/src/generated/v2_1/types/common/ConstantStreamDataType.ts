import type { CustomDataType } from './CustomDataType.js';
import type { PeriodicEventStreamParamsType } from './PeriodicEventStreamParamsType.js';

export interface ConstantStreamDataType {
  id: number;
  params: PeriodicEventStreamParamsType;
  variableMonitoringId: number;
  customData?: CustomDataType;
}
