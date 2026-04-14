import type { ExtendedTriggerMessageRequestedMessageEnum } from '../../enums/ExtendedTriggerMessageRequestedMessageEnum.js';

export interface ExtendedTriggerMessage {
  requestedMessage: ExtendedTriggerMessageRequestedMessageEnum;
  connectorId?: number;
}
