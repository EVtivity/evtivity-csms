import type { CustomDataType } from '../common/CustomDataType.js';

import type { ConnectorStatusEnum } from '../../enums/ConnectorStatusEnum.js';

export interface StatusNotificationRequest {
  customData?: CustomDataType;
  timestamp: string;
  connectorStatus: ConnectorStatusEnum;
  evseId: number;
  connectorId: number;
}
