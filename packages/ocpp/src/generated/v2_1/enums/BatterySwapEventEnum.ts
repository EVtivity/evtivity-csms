export const BatterySwapEventEnum = {
  BatteryIn: 'BatteryIn',
  BatteryOut: 'BatteryOut',
  BatteryOutTimeout: 'BatteryOutTimeout',
} as const;

export type BatterySwapEventEnum = (typeof BatterySwapEventEnum)[keyof typeof BatterySwapEventEnum];
