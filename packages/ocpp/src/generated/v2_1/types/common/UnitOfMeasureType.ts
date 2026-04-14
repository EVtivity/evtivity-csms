import type { CustomDataType } from './CustomDataType.js';

export interface UnitOfMeasureType {
  unit?: string;
  multiplier?: number;
  customData?: CustomDataType;
}
