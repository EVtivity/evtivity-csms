import type { ComponentType } from '../common/ComponentType.js';
import type { CustomDataType } from '../common/CustomDataType.js';
import type { VariableType } from '../common/VariableType.js';

import type { AttributeEnum } from '../../enums/AttributeEnum.js';

export interface SetVariableDataType {
  customData?: CustomDataType;
  attributeType?: AttributeEnum;
  attributeValue: string;
  component: ComponentType;
  variable: VariableType;
}

export interface SetVariablesRequest {
  customData?: CustomDataType;
  setVariableData: SetVariableDataType[];
}
