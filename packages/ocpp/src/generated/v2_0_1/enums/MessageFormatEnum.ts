export const MessageFormatEnum = {
  ASCII: 'ASCII',
  HTML: 'HTML',
  URI: 'URI',
  UTF8: 'UTF8',
} as const;

export type MessageFormatEnum = (typeof MessageFormatEnum)[keyof typeof MessageFormatEnum];
