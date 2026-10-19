import type { CostType } from './CostType.js';
import type { CustomDataType } from './CustomDataType.js';

export interface ConsumptionCostType {
  customData?: CustomDataType;
  startValue: number;
  cost: CostType[];
}
