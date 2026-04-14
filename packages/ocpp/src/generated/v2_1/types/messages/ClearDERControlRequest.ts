import type { CustomDataType } from '../common/CustomDataType.js';

import type { DERControlEnum } from '../../enums/DERControlEnum.js';

export interface ClearDERControlRequest {
  isDefault: boolean;
  controlType?: DERControlEnum;
  controlId?: string;
  customData?: CustomDataType;
}
