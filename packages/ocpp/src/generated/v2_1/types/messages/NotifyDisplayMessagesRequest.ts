import type { CustomDataType } from '../common/CustomDataType.js';
import type { MessageInfoType } from '../common/MessageInfoType.js';

export interface NotifyDisplayMessagesRequest {
  messageInfo?: MessageInfoType[];
  requestId: number;
  tbc?: boolean;
  customData?: CustomDataType;
}
