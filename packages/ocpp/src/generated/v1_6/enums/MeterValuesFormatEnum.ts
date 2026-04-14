export const MeterValuesFormatEnum = {
  Raw: 'Raw',
  SignedData: 'SignedData',
} as const;

export type MeterValuesFormatEnum = (typeof MeterValuesFormatEnum)[keyof typeof MeterValuesFormatEnum];
