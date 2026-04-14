import type { CustomDataType } from '../common/CustomDataType.js';

export interface ClosePeriodicEventStreamRequest {
  id: number;
  customData?: CustomDataType;
}
