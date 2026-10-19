import type { CustomDataType } from '../common/CustomDataType.js';

export interface ClearVariableMonitoringRequest {
  customData?: CustomDataType;
  id: number[];
}
