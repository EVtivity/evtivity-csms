export const ComponentCriterionEnum = {
  Active: 'Active',
  Available: 'Available',
  Enabled: 'Enabled',
  Problem: 'Problem',
} as const;

export type ComponentCriterionEnum = (typeof ComponentCriterionEnum)[keyof typeof ComponentCriterionEnum];
