export const EventTriggerEnum = {
  Alerting: 'Alerting',
  Delta: 'Delta',
  Periodic: 'Periodic',
} as const;

export type EventTriggerEnum = (typeof EventTriggerEnum)[keyof typeof EventTriggerEnum];
