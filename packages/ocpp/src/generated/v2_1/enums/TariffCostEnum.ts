export const TariffCostEnum = {
  NormalCost: 'NormalCost',
  MinCost: 'MinCost',
  MaxCost: 'MaxCost',
} as const;

export type TariffCostEnum = (typeof TariffCostEnum)[keyof typeof TariffCostEnum];
