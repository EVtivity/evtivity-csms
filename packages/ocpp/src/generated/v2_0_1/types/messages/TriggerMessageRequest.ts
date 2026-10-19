import type { CustomDataType } from '../common/CustomDataType.js';
import type { EVSEType } from '../common/EVSEType.js';

import type { MessageTriggerEnum } from '../../enums/MessageTriggerEnum.js';

export interface TriggerMessageRequest {
  customData?: CustomDataType;
  evse?: EVSEType;
  requestedMessage: MessageTriggerEnum;
}
