export const TariffGetStatusEnum = {
  Accepted: 'Accepted',
  Rejected: 'Rejected',
  NoTariff: 'NoTariff',
} as const;

export type TariffGetStatusEnum = (typeof TariffGetStatusEnum)[keyof typeof TariffGetStatusEnum];
