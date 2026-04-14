import type { ConsumptionCostType } from './ConsumptionCostType.js';
import type { CustomDataType } from './CustomDataType.js';
import type { RelativeTimeIntervalType } from './RelativeTimeIntervalType.js';

export interface SalesTariffEntryType {
  relativeTimeInterval: RelativeTimeIntervalType;
  ePriceLevel?: number;
  consumptionCost?: ConsumptionCostType[];
  customData?: CustomDataType;
}
