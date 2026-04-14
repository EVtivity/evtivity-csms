import type { CustomDataType } from './CustomDataType.js';

export interface TransactionLimitType {
  maxCost?: number;
  maxEnergy?: number;
  maxTime?: number;
  maxSoC?: number;
  customData?: CustomDataType;
}
