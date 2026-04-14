import type { CustomDataType } from './CustomDataType.js';
import type { PriceLevelScheduleEntryType } from './PriceLevelScheduleEntryType.js';

export interface PriceLevelScheduleType {
  priceLevelScheduleEntries: PriceLevelScheduleEntryType[];
  timeAnchor: string;
  priceScheduleId: number;
  priceScheduleDescription?: string;
  numberOfPriceLevels: number;
  customData?: CustomDataType;
}
