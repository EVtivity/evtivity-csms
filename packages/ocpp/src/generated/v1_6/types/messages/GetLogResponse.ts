import type { GetLogStatusEnum } from '../../enums/GetLogStatusEnum.js';

export interface GetLogResponse {
  status: GetLogStatusEnum;
  filename?: string;
}
