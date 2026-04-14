export const CostDimensionEnum = {
  Energy: 'Energy',
  MaxCurrent: 'MaxCurrent',
  MinCurrent: 'MinCurrent',
  MaxPower: 'MaxPower',
  MinPower: 'MinPower',
  IdleTIme: 'IdleTIme',
  ChargingTime: 'ChargingTime',
} as const;

export type CostDimensionEnum = (typeof CostDimensionEnum)[keyof typeof CostDimensionEnum];
