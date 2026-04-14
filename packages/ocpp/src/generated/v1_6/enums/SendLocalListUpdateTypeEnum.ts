export const SendLocalListUpdateTypeEnum = {
  Differential: 'Differential',
  Full: 'Full',
} as const;

export type SendLocalListUpdateTypeEnum = (typeof SendLocalListUpdateTypeEnum)[keyof typeof SendLocalListUpdateTypeEnum];
