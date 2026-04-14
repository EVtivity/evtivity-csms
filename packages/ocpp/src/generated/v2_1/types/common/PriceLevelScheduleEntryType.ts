import type { CustomDataType } from './CustomDataType.js';

export interface PriceLevelScheduleEntryType {
  duration: number;
  priceLevel: number;
  customData?: CustomDataType;
}
