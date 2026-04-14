export const AttributeEnum = {
  Actual: 'Actual',
  Target: 'Target',
  MinSet: 'MinSet',
  MaxSet: 'MaxSet',
} as const;

export type AttributeEnum = (typeof AttributeEnum)[keyof typeof AttributeEnum];
