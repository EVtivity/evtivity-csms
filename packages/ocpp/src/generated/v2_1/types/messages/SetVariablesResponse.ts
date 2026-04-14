import type { ComponentType } from '../common/ComponentType.js';
import type { CustomDataType } from '../common/CustomDataType.js';
import type { StatusInfoType } from '../common/StatusInfoType.js';
import type { VariableType } from '../common/VariableType.js';

import type { AttributeEnum } from '../../enums/AttributeEnum.js';
import type { SetVariableStatusEnum } from '../../enums/SetVariableStatusEnum.js';

export interface SetVariableResultType {
  attributeType?: AttributeEnum;
  attributeStatus: SetVariableStatusEnum;
  attributeStatusInfo?: StatusInfoType;
  component: ComponentType;
  variable: VariableType;
  customData?: CustomDataType;
}

export interface SetVariablesResponse {
  setVariableResult: SetVariableResultType[];
  customData?: CustomDataType;
}
