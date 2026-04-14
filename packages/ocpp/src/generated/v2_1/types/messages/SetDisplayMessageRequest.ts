import type { CustomDataType } from '../common/CustomDataType.js';
import type { MessageInfoType } from '../common/MessageInfoType.js';

export interface SetDisplayMessageRequest {
  message: MessageInfoType;
  customData?: CustomDataType;
}
