import type { CustomDataType } from '../common/CustomDataType.js';
import type { DERCurveType } from '../common/DERCurveType.js';
import type { EnterServiceType } from '../common/EnterServiceType.js';
import type { FixedPFType } from '../common/FixedPFType.js';
import type { FixedVarType } from '../common/FixedVarType.js';
import type { FreqDroopType } from '../common/FreqDroopType.js';
import type { GradientType } from '../common/GradientType.js';
import type { LimitMaxDischargeType } from '../common/LimitMaxDischargeType.js';

import type { DERControlEnum } from '../../enums/DERControlEnum.js';

export interface SetDERControlRequest {
  isDefault: boolean;
  controlId: string;
  controlType: DERControlEnum;
  curve?: DERCurveType;
  enterService?: EnterServiceType;
  fixedPFAbsorb?: FixedPFType;
  fixedPFInject?: FixedPFType;
  fixedVar?: FixedVarType;
  freqDroop?: FreqDroopType;
  gradient?: GradientType;
  limitMaxDischarge?: LimitMaxDischargeType;
  customData?: CustomDataType;
}
