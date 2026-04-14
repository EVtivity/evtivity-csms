import type { ComponentType } from '../common/ComponentType.js';
import type { CustomDataType } from '../common/CustomDataType.js';
import type { VariableType } from '../common/VariableType.js';

import type { AttributeEnum } from '../../enums/AttributeEnum.js';

export interface SetVariableDataType {
  attributeType?: AttributeEnum;
  attributeValue: string;
  component: ComponentType;
  variable: VariableType;
  customData?: CustomDataType;
}

export interface SetVariablesRequest {
  setVariableData: SetVariableDataType[];
  customData?: CustomDataType;
}
