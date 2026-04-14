import type { ComponentVariableType } from '../common/ComponentVariableType.js';
import type { CustomDataType } from '../common/CustomDataType.js';

import type { ComponentCriterionEnum } from '../../enums/ComponentCriterionEnum.js';

export interface GetReportRequest {
  componentVariable?: ComponentVariableType[];
  requestId: number;
  componentCriteria?: ComponentCriterionEnum[];
  customData?: CustomDataType;
}
