import type { CustomDataType } from './CustomDataType.js';

export interface UnitOfMeasureType {
  customData?: CustomDataType;
  unit?: string;
  multiplier?: number;
}
