import type { CustomDataType } from './CustomDataType.js';

export interface RelativeTimeIntervalType {
  start: number;
  duration?: number;
  customData?: CustomDataType;
}
