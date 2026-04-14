import type { CustomDataType } from '../common/CustomDataType.js';

export interface ClearDisplayMessageRequest {
  id: number;
  customData?: CustomDataType;
}
