// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect } from 'vitest';
import {
  recoveryCodesFileDate,
  recoveryCodesFileName,
  recoveryCodesFileText,
} from '../recovery-codes-file';

describe('recovery codes file', () => {
  it('is named after the company, with spaces as dashes', () => {
    expect(recoveryCodesFileName('Acme Charging  Co')).toBe('Acme-Charging-Co-recovery-codes.txt');
    expect(recoveryCodesFileName('充电 网络')).toBe('充电-网络-recovery-codes.txt');
  });

  it('drops characters a file name cannot hold', () => {
    expect(recoveryCodesFileName('A/B: "C"?')).toBe('AB-C-recovery-codes.txt');
  });

  it('falls back to recovery-codes.txt without a usable name', () => {
    expect(recoveryCodesFileName(undefined)).toBe('recovery-codes.txt');
    expect(recoveryCodesFileName(null)).toBe('recovery-codes.txt');
    expect(recoveryCodesFileName('  ')).toBe('recovery-codes.txt');
    expect(recoveryCodesFileName('///')).toBe('recovery-codes.txt');
  });

  it('holds the header, a blank line and one code per line', () => {
    expect(recoveryCodesFileText('Header', ['aaaaa-bbbbb', 'ccccc-ddddd'])).toBe(
      'Header\n\naaaaa-bbbbb\nccccc-ddddd\n',
    );
  });

  it('dates the file as YYYY-MM-DD in local time', () => {
    expect(recoveryCodesFileDate(new Date(2026, 0, 5, 23, 59))).toBe('2026-01-05');
    expect(recoveryCodesFileDate(new Date(2026, 11, 31, 0, 1))).toBe('2026-12-31');
  });
});
