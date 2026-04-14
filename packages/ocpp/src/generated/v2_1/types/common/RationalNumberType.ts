import type { CustomDataType } from './CustomDataType.js';

export interface RationalNumberType {
  exponent: number;
  value: number;
  customData?: CustomDataType;
}
