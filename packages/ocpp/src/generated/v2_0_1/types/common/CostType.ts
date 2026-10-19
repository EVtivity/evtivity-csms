import type { CustomDataType } from './CustomDataType.js';

import type { CostKindEnum } from '../../enums/CostKindEnum.js';

export interface CostType {
  customData?: CustomDataType;
  costKind: CostKindEnum;
  amount: number;
  amountMultiplier?: number;
}
