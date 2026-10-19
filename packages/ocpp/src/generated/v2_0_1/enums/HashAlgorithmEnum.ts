export const HashAlgorithmEnum = {
  SHA256: 'SHA256',
  SHA384: 'SHA384',
  SHA512: 'SHA512',
} as const;

export type HashAlgorithmEnum = (typeof HashAlgorithmEnum)[keyof typeof HashAlgorithmEnum];
