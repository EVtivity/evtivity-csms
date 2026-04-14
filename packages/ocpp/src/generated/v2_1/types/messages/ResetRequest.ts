import type { CustomDataType } from '../common/CustomDataType.js';

import type { ResetEnum } from '../../enums/ResetEnum.js';

export interface ResetRequest {
  type: ResetEnum;
  evseId?: number;
  customData?: CustomDataType;
}
