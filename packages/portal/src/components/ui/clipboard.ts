// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

/**
 * Copies `text` to the clipboard. The one place the portal writes the
 * clipboard (ESLint `evtivity/no-raw-clipboard`): `CopyableId` calls it.
 * Rejects when the browser refuses.
 */
export async function copyText(text: string): Promise<void> {
  // navigator.clipboard is undefined on non-secure (plain HTTP) origins.
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
  if (navigator.clipboard != null) {
    await navigator.clipboard.writeText(text);
    return;
  }
  const textarea = document.createElement('textarea');
  textarea.value = text;
  textarea.style.position = 'fixed';
  textarea.style.opacity = '0';
  document.body.appendChild(textarea);
  textarea.select();
  try {
    // The only copy path a non-secure origin has.
    // eslint-disable-next-line @typescript-eslint/no-deprecated
    if (!document.execCommand('copy')) throw new Error('Clipboard unavailable');
  } finally {
    document.body.removeChild(textarea);
  }
}
