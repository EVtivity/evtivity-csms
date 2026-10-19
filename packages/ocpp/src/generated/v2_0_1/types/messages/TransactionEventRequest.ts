import type { CustomDataType } from '../common/CustomDataType.js';
import type { EVSEType } from '../common/EVSEType.js';
import type { IdTokenType } from '../common/IdTokenType.js';
import type { MeterValueType } from '../common/MeterValueType.js';

import type { ChargingStateEnum } from '../../enums/ChargingStateEnum.js';
import type { ReasonEnum } from '../../enums/ReasonEnum.js';
import type { TransactionEventEnum } from '../../enums/TransactionEventEnum.js';
import type { TriggerReasonEnum } from '../../enums/TriggerReasonEnum.js';

export interface TransactionType {
  customData?: CustomDataType;
  transactionId: string;
  chargingState?: ChargingStateEnum;
  timeSpentCharging?: number;
  stoppedReason?: ReasonEnum;
  remoteStartId?: number;
}

export interface TransactionEventRequest {
  customData?: CustomDataType;
  eventType: TransactionEventEnum;
  meterValue?: MeterValueType[];
  timestamp: string;
  triggerReason: TriggerReasonEnum;
  seqNo: number;
  offline?: boolean;
  numberOfPhasesUsed?: number;
  cableMaxCurrent?: number;
  reservationId?: number;
  transactionInfo: TransactionType;
  evse?: EVSEType;
  idToken?: IdTokenType;
}
