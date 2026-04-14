export const OCPPInterfaceEnum = {
  Wired0: 'Wired0',
  Wired1: 'Wired1',
  Wired2: 'Wired2',
  Wired3: 'Wired3',
  Wireless0: 'Wireless0',
  Wireless1: 'Wireless1',
  Wireless2: 'Wireless2',
  Wireless3: 'Wireless3',
  Any: 'Any',
} as const;

export type OCPPInterfaceEnum = (typeof OCPPInterfaceEnum)[keyof typeof OCPPInterfaceEnum];
