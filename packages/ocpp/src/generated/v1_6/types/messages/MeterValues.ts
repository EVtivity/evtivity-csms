import type { SampledValueType } from '../common/SampledValueType.js';

export interface MeterValueType {
  timestamp: string;
  sampledValue: SampledValueType[];
}

export interface MeterValues {
  connectorId: number;
  transactionId?: number;
  meterValue: MeterValueType[];
}
