import type { ComponentVariableType } from '../common/ComponentVariableType.js';
import type { CustomDataType } from '../common/CustomDataType.js';

import type { MonitoringCriterionEnum } from '../../enums/MonitoringCriterionEnum.js';

export interface GetMonitoringReportRequest {
  componentVariable?: ComponentVariableType[];
  requestId: number;
  monitoringCriteria?: MonitoringCriterionEnum[];
  customData?: CustomDataType;
}
