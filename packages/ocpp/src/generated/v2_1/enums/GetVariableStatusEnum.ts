export const GetVariableStatusEnum = {
  Accepted: 'Accepted',
  Rejected: 'Rejected',
  UnknownComponent: 'UnknownComponent',
  UnknownVariable: 'UnknownVariable',
  NotSupportedAttributeType: 'NotSupportedAttributeType',
} as const;

export type GetVariableStatusEnum = (typeof GetVariableStatusEnum)[keyof typeof GetVariableStatusEnum];
