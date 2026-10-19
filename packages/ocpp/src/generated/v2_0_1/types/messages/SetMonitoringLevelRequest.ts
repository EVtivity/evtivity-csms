import type { CustomDataType } from '../common/CustomDataType.js';

export interface SetMonitoringLevelRequest {
  customData?: CustomDataType;
  severity: number;
}
