export const TariffClearStatusEnum = {
  Accepted: 'Accepted',
  Rejected: 'Rejected',
  NoTariff: 'NoTariff',
} as const;

export type TariffClearStatusEnum = (typeof TariffClearStatusEnum)[keyof typeof TariffClearStatusEnum];
