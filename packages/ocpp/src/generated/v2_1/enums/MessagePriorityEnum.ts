export const MessagePriorityEnum = {
  AlwaysFront: 'AlwaysFront',
  InFront: 'InFront',
  NormalCycle: 'NormalCycle',
} as const;

export type MessagePriorityEnum = (typeof MessagePriorityEnum)[keyof typeof MessagePriorityEnum];
