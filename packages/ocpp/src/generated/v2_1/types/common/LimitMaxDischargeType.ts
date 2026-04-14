import type { CustomDataType } from './CustomDataType.js';
import type { DERCurveType } from './DERCurveType.js';

export interface LimitMaxDischargeType {
  priority: number;
  pctMaxDischargePower?: number;
  powerMonitoringMustTrip?: DERCurveType;
  startTime?: string;
  duration?: number;
  customData?: CustomDataType;
}
