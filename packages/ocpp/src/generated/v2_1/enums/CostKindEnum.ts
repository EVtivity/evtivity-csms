export const CostKindEnum = {
  CarbonDioxideEmission: 'CarbonDioxideEmission',
  RelativePricePercentage: 'RelativePricePercentage',
  RenewableGenerationPercentage: 'RenewableGenerationPercentage',
} as const;

export type CostKindEnum = (typeof CostKindEnum)[keyof typeof CostKindEnum];
