export const UpdateEnum = {
  Differential: 'Differential',
  Full: 'Full',
} as const;

export type UpdateEnum = (typeof UpdateEnum)[keyof typeof UpdateEnum];
