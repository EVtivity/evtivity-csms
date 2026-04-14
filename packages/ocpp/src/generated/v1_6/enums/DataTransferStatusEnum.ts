export const DataTransferStatusEnum = {
  Accepted: 'Accepted',
  Rejected: 'Rejected',
  UnknownMessageId: 'UnknownMessageId',
  UnknownVendorId: 'UnknownVendorId',
} as const;

export type DataTransferStatusEnum = (typeof DataTransferStatusEnum)[keyof typeof DataTransferStatusEnum];
