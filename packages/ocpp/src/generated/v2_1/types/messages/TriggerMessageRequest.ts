import type { CustomDataType } from '../common/CustomDataType.js';
import type { EVSEType } from '../common/EVSEType.js';

import type { MessageTriggerEnum } from '../../enums/MessageTriggerEnum.js';

export interface TriggerMessageRequest {
  evse?: EVSEType;
  requestedMessage: MessageTriggerEnum;
  customTrigger?: string;
  customData?: CustomDataType;
}
