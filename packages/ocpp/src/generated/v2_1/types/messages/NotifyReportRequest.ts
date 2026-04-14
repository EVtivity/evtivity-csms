import type { ComponentType } from '../common/ComponentType.js';
import type { CustomDataType } from '../common/CustomDataType.js';
import type { VariableType } from '../common/VariableType.js';

import type { AttributeEnum } from '../../enums/AttributeEnum.js';
import type { DataEnum } from '../../enums/DataEnum.js';
import type { MutabilityEnum } from '../../enums/MutabilityEnum.js';

export interface ReportDataType {
  component: ComponentType;
  variable: VariableType;
  variableAttribute: VariableAttributeType[];
  variableCharacteristics?: VariableCharacteristicsType;
  customData?: CustomDataType;
}

export interface VariableAttributeType {
  type?: AttributeEnum;
  value?: string;
  mutability?: MutabilityEnum;
  persistent?: boolean;
  constant?: boolean;
  customData?: CustomDataType;
}

export interface VariableCharacteristicsType {
  unit?: string;
  dataType: DataEnum;
  minLimit?: number;
  maxLimit?: number;
  maxElements?: number;
  valuesList?: string;
  supportsMonitoring: boolean;
  customData?: CustomDataType;
}

export interface NotifyReportRequest {
  requestId: number;
  generatedAt: string;
  reportData?: ReportDataType[];
  tbc?: boolean;
  seqNo: number;
  customData?: CustomDataType;
}
