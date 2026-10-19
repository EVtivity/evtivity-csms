import type { CustomDataType } from './CustomDataType.js';

export interface RelativeTimeIntervalType {
  customData?: CustomDataType;
  start: number;
  duration?: number;
}
