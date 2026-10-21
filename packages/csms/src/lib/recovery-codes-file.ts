// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

// Characters no file system accepts in a name.
const UNSAFE_FILE_NAME_CHARACTERS = /[\\/:*?"<>|]/g;

/** `<company name>-recovery-codes.txt`, or `recovery-codes.txt` without a name. */
export function recoveryCodesFileName(companyName: string | null | undefined): string {
  const name = (companyName ?? '')
    .replace(UNSAFE_FILE_NAME_CHARACTERS, '')
    .trim()
    .replace(/\s+/g, '-');
  return name === '' ? 'recovery-codes.txt' : `${name}-recovery-codes.txt`;
}

/** The header line, a blank line, then one code per line. */
export function recoveryCodesFileText(header: string, codes: string[]): string {
  return [header, '', ...codes, ''].join('\n');
}

/** The local date as YYYY-MM-DD, the same in every language. */
export function recoveryCodesFileDate(now: Date = new Date()): string {
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  return `${String(now.getFullYear())}-${month}-${day}`;
}

/** Hands the text to the browser as a file to save. */
export function saveTextFile(fileName: string, text: string): void {
  const url = URL.createObjectURL(new Blob([text], { type: 'text/plain;charset=utf-8' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = fileName;
  link.click();
  URL.revokeObjectURL(url);
}
