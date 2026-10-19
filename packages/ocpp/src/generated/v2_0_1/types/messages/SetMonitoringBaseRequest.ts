import type { CustomDataType } from '../common/CustomDataType.js';

import type { MonitoringBaseEnum } from '../../enums/MonitoringBaseEnum.js';

export interface SetMonitoringBaseRequest {
  customData?: CustomDataType;
  monitoringBase: MonitoringBaseEnum;
}
