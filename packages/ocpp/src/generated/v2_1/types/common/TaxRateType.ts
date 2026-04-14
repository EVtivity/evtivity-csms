import type { CustomDataType } from './CustomDataType.js';

export interface TaxRateType {
  type: string;
  tax: number;
  stack?: number;
  customData?: CustomDataType;
}
