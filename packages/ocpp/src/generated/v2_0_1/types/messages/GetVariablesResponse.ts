import type { ComponentType } from '../common/ComponentType.js';
import type { CustomDataType } from '../common/CustomDataType.js';
import type { StatusInfoType } from '../common/StatusInfoType.js';
import type { VariableType } from '../common/VariableType.js';

import type { AttributeEnum } from '../../enums/AttributeEnum.js';
import type { GetVariableStatusEnum } from '../../enums/GetVariableStatusEnum.js';

export interface GetVariableResultType {
  customData?: CustomDataType;
  attributeStatusInfo?: StatusInfoType;
  attributeStatus: GetVariableStatusEnum;
  attributeType?: AttributeEnum;
  attributeValue?: string;
  component: ComponentType;
  variable: VariableType;
}

export interface GetVariablesResponse {
  customData?: CustomDataType;
  getVariableResult: GetVariableResultType[];
}
