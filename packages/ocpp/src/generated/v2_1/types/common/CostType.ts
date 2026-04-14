import type { CustomDataType } from './CustomDataType.js';

import type { CostKindEnum } from '../../enums/CostKindEnum.js';

export interface CostType {
  costKind: CostKindEnum;
  amount: number;
  amountMultiplier?: number;
  customData?: CustomDataType;
}
