import type { CustomDataType } from '../common/CustomDataType.js';
import type { DERCurveType } from '../common/DERCurveType.js';
import type { EnterServiceType } from '../common/EnterServiceType.js';
import type { FixedPFType } from '../common/FixedPFType.js';
import type { FixedVarType } from '../common/FixedVarType.js';
import type { FreqDroopType } from '../common/FreqDroopType.js';
import type { GradientType } from '../common/GradientType.js';
import type { LimitMaxDischargeType } from '../common/LimitMaxDischargeType.js';

import type { DERControlEnum } from '../../enums/DERControlEnum.js';

export interface DERCurveGetType {
  curve: DERCurveType;
  id: string;
  curveType: DERControlEnum;
  isDefault: boolean;
  isSuperseded: boolean;
  customData?: CustomDataType;
}

export interface EnterServiceGetType {
  enterService: EnterServiceType;
  id: string;
  customData?: CustomDataType;
}

export interface FixedPFGetType {
  fixedPF: FixedPFType;
  id: string;
  isDefault: boolean;
  isSuperseded: boolean;
  customData?: CustomDataType;
}

export interface FixedVarGetType {
  fixedVar: FixedVarType;
  id: string;
  isDefault: boolean;
  isSuperseded: boolean;
  customData?: CustomDataType;
}

export interface FreqDroopGetType {
  freqDroop: FreqDroopType;
  id: string;
  isDefault: boolean;
  isSuperseded: boolean;
  customData?: CustomDataType;
}

export interface GradientGetType {
  gradient: GradientType;
  id: string;
  customData?: CustomDataType;
}

export interface LimitMaxDischargeGetType {
  id: string;
  isDefault: boolean;
  isSuperseded: boolean;
  limitMaxDischarge: LimitMaxDischargeType;
  customData?: CustomDataType;
}

export interface ReportDERControlRequest {
  curve?: DERCurveGetType[];
  enterService?: EnterServiceGetType[];
  fixedPFAbsorb?: FixedPFGetType[];
  fixedPFInject?: FixedPFGetType[];
  fixedVar?: FixedVarGetType[];
  freqDroop?: FreqDroopGetType[];
  gradient?: GradientGetType[];
  limitMaxDischarge?: LimitMaxDischargeGetType[];
  requestId: number;
  tbc?: boolean;
  customData?: CustomDataType;
}
