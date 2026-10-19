export const APNAuthenticationEnum = {
  CHAP: 'CHAP',
  NONE: 'NONE',
  PAP: 'PAP',
  AUTO: 'AUTO',
} as const;

export type APNAuthenticationEnum = (typeof APNAuthenticationEnum)[keyof typeof APNAuthenticationEnum];
