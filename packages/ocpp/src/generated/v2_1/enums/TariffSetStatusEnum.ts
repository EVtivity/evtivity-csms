export const TariffSetStatusEnum = {
  Accepted: 'Accepted',
  Rejected: 'Rejected',
  TooManyElements: 'TooManyElements',
  ConditionNotSupported: 'ConditionNotSupported',
  DuplicateTariffId: 'DuplicateTariffId',
} as const;

export type TariffSetStatusEnum = (typeof TariffSetStatusEnum)[keyof typeof TariffSetStatusEnum];
