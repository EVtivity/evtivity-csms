import type { GetLogLogTypeEnum } from '../../enums/GetLogLogTypeEnum.js';

export interface LogType {
  remoteLocation: string;
  oldestTimestamp?: string;
  latestTimestamp?: string;
}

export interface GetLog {
  logType: GetLogLogTypeEnum;
  requestId: number;
  retries?: number;
  retryInterval?: number;
  log: LogType;
}
