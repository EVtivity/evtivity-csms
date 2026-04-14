export const TriggerMessageRequestedMessageEnum = {
  BootNotification: 'BootNotification',
  DiagnosticsStatusNotification: 'DiagnosticsStatusNotification',
  FirmwareStatusNotification: 'FirmwareStatusNotification',
  Heartbeat: 'Heartbeat',
  MeterValues: 'MeterValues',
  StatusNotification: 'StatusNotification',
} as const;

export type TriggerMessageRequestedMessageEnum = (typeof TriggerMessageRequestedMessageEnum)[keyof typeof TriggerMessageRequestedMessageEnum];
