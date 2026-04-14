import type { CustomDataType } from '../common/CustomDataType.js';

import type { LogEnum } from '../../enums/LogEnum.js';

export interface LogParametersType {
  remoteLocation: string;
  oldestTimestamp?: string;
  latestTimestamp?: string;
  customData?: CustomDataType;
}

export interface GetLogRequest {
  log: LogParametersType;
  logType: LogEnum;
  requestId: number;
  retries?: number;
  retryInterval?: number;
  customData?: CustomDataType;
}
