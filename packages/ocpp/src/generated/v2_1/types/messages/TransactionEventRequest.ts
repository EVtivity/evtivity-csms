import type { CustomDataType } from '../common/CustomDataType.js';
import type { EVSEType } from '../common/EVSEType.js';
import type { IdTokenType } from '../common/IdTokenType.js';
import type { MeterValueType } from '../common/MeterValueType.js';
import type { PriceType } from '../common/PriceType.js';
import type { TransactionLimitType } from '../common/TransactionLimitType.js';

import type { ChargingStateEnum } from '../../enums/ChargingStateEnum.js';
import type { CostDimensionEnum } from '../../enums/CostDimensionEnum.js';
import type { OperationModeEnum } from '../../enums/OperationModeEnum.js';
import type { PreconditioningStatusEnum } from '../../enums/PreconditioningStatusEnum.js';
import type { ReasonEnum } from '../../enums/ReasonEnum.js';
import type { TariffCostEnum } from '../../enums/TariffCostEnum.js';
import type { TransactionEventEnum } from '../../enums/TransactionEventEnum.js';
import type { TriggerReasonEnum } from '../../enums/TriggerReasonEnum.js';

export interface ChargingPeriodType {
  dimensions?: CostDimensionType[];
  tariffId?: string;
  startPeriod: string;
  customData?: CustomDataType;
}

export interface CostDetailsType {
  chargingPeriods?: ChargingPeriodType[];
  totalCost: TotalCostType;
  totalUsage: TotalUsageType;
  failureToCalculate?: boolean;
  failureReason?: string;
  customData?: CustomDataType;
}

export interface CostDimensionType {
  type: CostDimensionEnum;
  volume: number;
  customData?: CustomDataType;
}

export interface TotalCostType {
  currency: string;
  typeOfCost: TariffCostEnum;
  fixed?: PriceType;
  energy?: PriceType;
  chargingTime?: PriceType;
  idleTime?: PriceType;
  reservationTime?: PriceType;
  reservationFixed?: PriceType;
  total: TotalPriceType;
  customData?: CustomDataType;
}

export interface TotalPriceType {
  exclTax?: number;
  inclTax?: number;
  customData?: CustomDataType;
}

export interface TotalUsageType {
  energy: number;
  chargingTime: number;
  idleTime: number;
  reservationTime?: number;
  customData?: CustomDataType;
}

export interface TransactionType {
  transactionId: string;
  chargingState?: ChargingStateEnum;
  timeSpentCharging?: number;
  stoppedReason?: ReasonEnum;
  remoteStartId?: number;
  operationMode?: OperationModeEnum;
  tariffId?: string;
  transactionLimit?: TransactionLimitType;
  customData?: CustomDataType;
}

export interface TransactionEventRequest {
  costDetails?: CostDetailsType;
  eventType: TransactionEventEnum;
  meterValue?: MeterValueType[];
  timestamp: string;
  triggerReason: TriggerReasonEnum;
  seqNo: number;
  offline?: boolean;
  numberOfPhasesUsed?: number;
  cableMaxCurrent?: number;
  reservationId?: number;
  preconditioningStatus?: PreconditioningStatusEnum;
  evseSleep?: boolean;
  transactionInfo: TransactionType;
  evse?: EVSEType;
  idToken?: IdTokenType;
  customData?: CustomDataType;
}
