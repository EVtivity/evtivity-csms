import type { CustomDataType } from '../common/CustomDataType.js';

import type { LogEnum } from '../../enums/LogEnum.js';

export interface LogParametersType {
  customData?: CustomDataType;
  remoteLocation: string;
  oldestTimestamp?: string;
  latestTimestamp?: string;
}

export interface GetLogRequest {
  customData?: CustomDataType;
  log: LogParametersType;
  logType: LogEnum;
  requestId: number;
  retries?: number;
  retryInterval?: number;
}
