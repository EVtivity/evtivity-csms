export const ExtendedTriggerMessageRequestedMessageEnum = {
  BootNotification: 'BootNotification',
  LogStatusNotification: 'LogStatusNotification',
  FirmwareStatusNotification: 'FirmwareStatusNotification',
  Heartbeat: 'Heartbeat',
  MeterValues: 'MeterValues',
  SignChargePointCertificate: 'SignChargePointCertificate',
  StatusNotification: 'StatusNotification',
} as const;

export type ExtendedTriggerMessageRequestedMessageEnum = (typeof ExtendedTriggerMessageRequestedMessageEnum)[keyof typeof ExtendedTriggerMessageRequestedMessageEnum];
