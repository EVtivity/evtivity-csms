import type { CustomDataType } from '../common/CustomDataType.js';

export interface StreamDataElementType {
  t: number;
  v: string;
  customData?: CustomDataType;
}

export interface NotifyPeriodicEventStream {
  data: StreamDataElementType[];
  id: number;
  pending: number;
  basetime: string;
  customData?: CustomDataType;
}
