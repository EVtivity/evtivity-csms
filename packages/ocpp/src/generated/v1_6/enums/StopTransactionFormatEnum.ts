export const StopTransactionFormatEnum = {
  Raw: 'Raw',
  SignedData: 'SignedData',
} as const;

export type StopTransactionFormatEnum = (typeof StopTransactionFormatEnum)[keyof typeof StopTransactionFormatEnum];
