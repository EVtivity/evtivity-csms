export const ReportBaseEnum = {
  ConfigurationInventory: 'ConfigurationInventory',
  FullInventory: 'FullInventory',
  SummaryInventory: 'SummaryInventory',
} as const;

export type ReportBaseEnum = (typeof ReportBaseEnum)[keyof typeof ReportBaseEnum];
