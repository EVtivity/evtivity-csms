// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

/**
 * Fonts of Korean and Chinese PDFs (invoices and reports). The API and worker
 * images install the Debian `fonts-noto-cjk` package (packages/api/Dockerfile,
 * packages/worker/Dockerfile), which puts the Noto Sans CJK collections at
 * these fixed paths. Each collection holds one face per region, selected by
 * PostScript name, so Korean and Traditional Chinese get their regional glyph
 * forms. Without these files (local dev outside Docker) Korean and Chinese
 * PDFs render in English (`cjk-fonts.ts`).
 */
export const CJK_FONT_FILES = {
  regular: '/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc',
  bold: '/usr/share/fonts/opentype/noto/NotoSansCJK-Bold.ttc',
} as const;

export const CJK_FONT_FACES = {
  ko: { regular: 'NotoSansCJKkr-Regular', bold: 'NotoSansCJKkr-Bold' },
  zh: { regular: 'NotoSansCJKsc-Regular', bold: 'NotoSansCJKsc-Bold' },
  'zh-TW': { regular: 'NotoSansCJKtc-Regular', bold: 'NotoSansCJKtc-Bold' },
} as const;
