export const MessageStateEnum = {
  Charging: 'Charging',
  Faulted: 'Faulted',
  Idle: 'Idle',
  Unavailable: 'Unavailable',
} as const;

export type MessageStateEnum = (typeof MessageStateEnum)[keyof typeof MessageStateEnum];
