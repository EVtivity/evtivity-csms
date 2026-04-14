import type { DataTransferStatusEnum } from '../../enums/DataTransferStatusEnum.js';

export interface DataTransferResponse {
  status: DataTransferStatusEnum;
  data?: string;
}
