import type { CustomDataType } from '../common/CustomDataType.js';

export interface ClearDisplayMessageRequest {
  customData?: CustomDataType;
  id: number;
}
