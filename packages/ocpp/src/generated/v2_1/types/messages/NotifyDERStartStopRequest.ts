import type { CustomDataType } from '../common/CustomDataType.js';

export interface NotifyDERStartStopRequest {
  controlId: string;
  started: boolean;
  timestamp: string;
  supersededIds?: string[];
  customData?: CustomDataType;
}
