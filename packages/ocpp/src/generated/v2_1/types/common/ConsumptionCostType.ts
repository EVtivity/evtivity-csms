import type { CostType } from './CostType.js';
import type { CustomDataType } from './CustomDataType.js';

export interface ConsumptionCostType {
  startValue: number;
  cost: CostType[];
  customData?: CustomDataType;
}
