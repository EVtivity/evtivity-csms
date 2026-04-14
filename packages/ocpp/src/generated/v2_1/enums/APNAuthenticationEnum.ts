export const APNAuthenticationEnum = {
  PAP: 'PAP',
  CHAP: 'CHAP',
  NONE: 'NONE',
  AUTO: 'AUTO',
} as const;

export type APNAuthenticationEnum = (typeof APNAuthenticationEnum)[keyof typeof APNAuthenticationEnum];
