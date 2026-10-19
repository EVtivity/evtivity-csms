export const MonitoringBaseEnum = {
  All: 'All',
  FactoryDefault: 'FactoryDefault',
  HardWiredOnly: 'HardWiredOnly',
} as const;

export type MonitoringBaseEnum = (typeof MonitoringBaseEnum)[keyof typeof MonitoringBaseEnum];
