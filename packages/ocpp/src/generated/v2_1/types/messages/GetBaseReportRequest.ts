import type { CustomDataType } from '../common/CustomDataType.js';

import type { ReportBaseEnum } from '../../enums/ReportBaseEnum.js';

export interface GetBaseReportRequest {
  requestId: number;
  reportBase: ReportBaseEnum;
  customData?: CustomDataType;
}
