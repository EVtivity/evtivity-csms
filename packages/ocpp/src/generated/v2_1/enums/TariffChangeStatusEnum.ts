export const TariffChangeStatusEnum = {
  Accepted: 'Accepted',
  Rejected: 'Rejected',
  TooManyElements: 'TooManyElements',
  ConditionNotSupported: 'ConditionNotSupported',
  TxNotFound: 'TxNotFound',
  NoCurrencyChange: 'NoCurrencyChange',
} as const;

export type TariffChangeStatusEnum = (typeof TariffChangeStatusEnum)[keyof typeof TariffChangeStatusEnum];
