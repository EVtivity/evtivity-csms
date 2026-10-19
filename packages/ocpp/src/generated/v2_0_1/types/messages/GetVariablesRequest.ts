import type { ComponentType } from '../common/ComponentType.js';
import type { CustomDataType } from '../common/CustomDataType.js';
import type { VariableType } from '../common/VariableType.js';

import type { AttributeEnum } from '../../enums/AttributeEnum.js';

export interface GetVariableDataType {
  customData?: CustomDataType;
  attributeType?: AttributeEnum;
  component: ComponentType;
  variable: VariableType;
}

export interface GetVariablesRequest {
  customData?: CustomDataType;
  getVariableData: GetVariableDataType[];
}
