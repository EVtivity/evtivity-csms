export const SetVariableStatusEnum = {
  Accepted: 'Accepted',
  Rejected: 'Rejected',
  UnknownComponent: 'UnknownComponent',
  UnknownVariable: 'UnknownVariable',
  NotSupportedAttributeType: 'NotSupportedAttributeType',
  RebootRequired: 'RebootRequired',
} as const;

export type SetVariableStatusEnum = (typeof SetVariableStatusEnum)[keyof typeof SetVariableStatusEnum];
