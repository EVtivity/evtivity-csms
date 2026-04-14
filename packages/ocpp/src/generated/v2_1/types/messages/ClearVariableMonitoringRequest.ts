import type { CustomDataType } from '../common/CustomDataType.js';

export interface ClearVariableMonitoringRequest {
  id: number[];
  customData?: CustomDataType;
}
