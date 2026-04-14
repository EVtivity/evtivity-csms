export const NotifyAllowedEnergyTransferStatusEnum = {
  Accepted: 'Accepted',
  Rejected: 'Rejected',
} as const;

export type NotifyAllowedEnergyTransferStatusEnum = (typeof NotifyAllowedEnergyTransferStatusEnum)[keyof typeof NotifyAllowedEnergyTransferStatusEnum];
