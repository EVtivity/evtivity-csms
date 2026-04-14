export const MessageStateEnum = {
  Charging: 'Charging',
  Faulted: 'Faulted',
  Idle: 'Idle',
  Unavailable: 'Unavailable',
  Suspended: 'Suspended',
  Discharging: 'Discharging',
} as const;

export type MessageStateEnum = (typeof MessageStateEnum)[keyof typeof MessageStateEnum];
