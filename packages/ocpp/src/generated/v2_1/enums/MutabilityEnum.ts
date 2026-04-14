export const MutabilityEnum = {
  ReadOnly: 'ReadOnly',
  WriteOnly: 'WriteOnly',
  ReadWrite: 'ReadWrite',
} as const;

export type MutabilityEnum = (typeof MutabilityEnum)[keyof typeof MutabilityEnum];
