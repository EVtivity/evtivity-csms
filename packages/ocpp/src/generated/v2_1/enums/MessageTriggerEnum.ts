export const MessageTriggerEnum = {
  BootNotification: 'BootNotification',
  LogStatusNotification: 'LogStatusNotification',
  FirmwareStatusNotification: 'FirmwareStatusNotification',
  Heartbeat: 'Heartbeat',
  MeterValues: 'MeterValues',
  SignChargingStationCertificate: 'SignChargingStationCertificate',
  SignV2GCertificate: 'SignV2GCertificate',
  SignV2G20Certificate: 'SignV2G20Certificate',
  StatusNotification: 'StatusNotification',
  TransactionEvent: 'TransactionEvent',
  SignCombinedCertificate: 'SignCombinedCertificate',
  PublishFirmwareStatusNotification: 'PublishFirmwareStatusNotification',
  CustomTrigger: 'CustomTrigger',
} as const;

export type MessageTriggerEnum = (typeof MessageTriggerEnum)[keyof typeof MessageTriggerEnum];
