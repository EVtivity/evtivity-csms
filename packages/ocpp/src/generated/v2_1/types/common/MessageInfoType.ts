import type { ComponentType } from './ComponentType.js';
import type { CustomDataType } from './CustomDataType.js';
import type { MessageContentType } from './MessageContentType.js';

import type { MessagePriorityEnum } from '../../enums/MessagePriorityEnum.js';
import type { MessageStateEnum } from '../../enums/MessageStateEnum.js';

export interface MessageInfoType {
  display?: ComponentType;
  id: number;
  priority: MessagePriorityEnum;
  state?: MessageStateEnum;
  startDateTime?: string;
  endDateTime?: string;
  transactionId?: string;
  message: MessageContentType;
  messageExtra?: MessageContentType[];
  customData?: CustomDataType;
}
