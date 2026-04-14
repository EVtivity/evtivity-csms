import type { CustomDataType } from '../common/CustomDataType.js';
import type { StatusInfoType } from '../common/StatusInfoType.js';

import type { GenericDeviceModelStatusEnum } from '../../enums/GenericDeviceModelStatusEnum.js';

export interface GetBaseReportResponse {
  status: GenericDeviceModelStatusEnum;
  statusInfo?: StatusInfoType;
  customData?: CustomDataType;
}
