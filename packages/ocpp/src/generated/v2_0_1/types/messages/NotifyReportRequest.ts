import type { ComponentType } from '../common/ComponentType.js';
import type { CustomDataType } from '../common/CustomDataType.js';
import type { VariableType } from '../common/VariableType.js';

import type { AttributeEnum } from '../../enums/AttributeEnum.js';
import type { DataEnum } from '../../enums/DataEnum.js';
import type { MutabilityEnum } from '../../enums/MutabilityEnum.js';

export interface ReportDataType {
  customData?: CustomDataType;
  component: ComponentType;
  variable: VariableType;
  variableAttribute: VariableAttributeType[];
  variableCharacteristics?: VariableCharacteristicsType;
}

export interface VariableAttributeType {
  customData?: CustomDataType;
  type?: AttributeEnum;
  value?: string;
  mutability?: MutabilityEnum;
  persistent?: boolean;
  constant?: boolean;
}

export interface VariableCharacteristicsType {
  customData?: CustomDataType;
  unit?: string;
  dataType: DataEnum;
  minLimit?: number;
  maxLimit?: number;
  valuesList?: string;
  supportsMonitoring: boolean;
}

export interface NotifyReportRequest {
  customData?: CustomDataType;
  requestId: number;
  generatedAt: string;
  reportData?: ReportDataType[];
  tbc?: boolean;
  seqNo: number;
}
