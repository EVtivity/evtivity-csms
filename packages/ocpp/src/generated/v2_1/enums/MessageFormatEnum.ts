export const MessageFormatEnum = {
  ASCII: 'ASCII',
  HTML: 'HTML',
  URI: 'URI',
  UTF8: 'UTF8',
  QRCODE: 'QRCODE',
} as const;

export type MessageFormatEnum = (typeof MessageFormatEnum)[keyof typeof MessageFormatEnum];
