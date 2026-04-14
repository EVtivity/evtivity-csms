export const ControlModeEnum = {
  ScheduledControl: 'ScheduledControl',
  DynamicControl: 'DynamicControl',
} as const;

export type ControlModeEnum = (typeof ControlModeEnum)[keyof typeof ControlModeEnum];
