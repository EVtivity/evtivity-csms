import type { CustomDataType } from '../common/CustomDataType.js';

export interface SetMonitoringLevelRequest {
  severity: number;
  customData?: CustomDataType;
}
