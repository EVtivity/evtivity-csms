import type { CustomDataType } from './CustomDataType.js';
import type { DERCurvePointsType } from './DERCurvePointsType.js';
import type { HysteresisType } from './HysteresisType.js';
import type { ReactivePowerParamsType } from './ReactivePowerParamsType.js';
import type { VoltageParamsType } from './VoltageParamsType.js';

import type { DERUnitEnum } from '../../enums/DERUnitEnum.js';

export interface DERCurveType {
  curveData: DERCurvePointsType[];
  hysteresis?: HysteresisType;
  priority: number;
  reactivePowerParams?: ReactivePowerParamsType;
  voltageParams?: VoltageParamsType;
  yUnit: DERUnitEnum;
  responseTime?: number;
  startTime?: string;
  duration?: number;
  customData?: CustomDataType;
}
