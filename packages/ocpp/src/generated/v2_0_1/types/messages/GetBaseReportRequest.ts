import type { CustomDataType } from '../common/CustomDataType.js';

import type { ReportBaseEnum } from '../../enums/ReportBaseEnum.js';

export interface GetBaseReportRequest {
  customData?: CustomDataType;
  requestId: number;
  reportBase: ReportBaseEnum;
}
