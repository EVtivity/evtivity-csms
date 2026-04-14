import type { TriggerMessageRequestedMessageEnum } from '../../enums/TriggerMessageRequestedMessageEnum.js';

export interface TriggerMessage {
  requestedMessage: TriggerMessageRequestedMessageEnum;
  connectorId?: number;
}
