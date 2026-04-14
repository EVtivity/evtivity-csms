import type { CustomDataType } from './CustomDataType.js';

import type { DERUnitEnum } from '../../enums/DERUnitEnum.js';

export interface FixedVarType {
  priority: number;
  setpoint: number;
  unit: DERUnitEnum;
  startTime?: string;
  duration?: number;
  customData?: CustomDataType;
}
