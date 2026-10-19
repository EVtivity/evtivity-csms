export const MessageTriggerEnum = {
  BootNotification: 'BootNotification',
  LogStatusNotification: 'LogStatusNotification',
  FirmwareStatusNotification: 'FirmwareStatusNotification',
  Heartbeat: 'Heartbeat',
  MeterValues: 'MeterValues',
  SignChargingStationCertificate: 'SignChargingStationCertificate',
  SignV2GCertificate: 'SignV2GCertificate',
  StatusNotification: 'StatusNotification',
  TransactionEvent: 'TransactionEvent',
  SignCombinedCertificate: 'SignCombinedCertificate',
  PublishFirmwareStatusNotification: 'PublishFirmwareStatusNotification',
} as const;

export type MessageTriggerEnum = (typeof MessageTriggerEnum)[keyof typeof MessageTriggerEnum];
