export const TariffKindEnum = {
  DefaultTariff: 'DefaultTariff',
  DriverTariff: 'DriverTariff',
} as const;

export type TariffKindEnum = (typeof TariffKindEnum)[keyof typeof TariffKindEnum];
