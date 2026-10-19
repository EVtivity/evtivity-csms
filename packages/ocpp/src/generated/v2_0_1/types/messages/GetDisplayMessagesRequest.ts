import type { CustomDataType } from '../common/CustomDataType.js';

import type { MessagePriorityEnum } from '../../enums/MessagePriorityEnum.js';
import type { MessageStateEnum } from '../../enums/MessageStateEnum.js';

export interface GetDisplayMessagesRequest {
  customData?: CustomDataType;
  id?: number[];
  requestId: number;
  priority?: MessagePriorityEnum;
  state?: MessageStateEnum;
}
