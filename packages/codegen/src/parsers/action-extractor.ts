// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { ParsedSchema } from './schema-parser.js';

export type MessageType = 'Request' | 'Response' | 'Standalone';

export interface ActionInfo {
  action: string;
  messageType: MessageType;
  schema: ParsedSchema;
}

export interface ActionPair {
  action: string;
  request?: ActionInfo;
  response?: ActionInfo;
}

export function extractActionInfo(schema: ParsedSchema): ActionInfo {
  const base = schema.fileName.replace('.json', '');
  let action: string;
  let messageType: MessageType;

  if (base.endsWith('Request')) {
    action = base.slice(0, -'Request'.length);
    messageType = 'Request';
  } else if (base.endsWith('Response')) {
    action = base.slice(0, -'Response'.length);
    messageType = 'Response';
  } else {
    action = base;
    messageType = 'Standalone';
  }

  return { action, messageType, schema };
}

export function groupActionPairs(schemas: ParsedSchema[]): Map<string, ActionPair> {
  const pairs = new Map<string, ActionPair>();

  for (const schema of schemas) {
    const info = extractActionInfo(schema);
    let pair = pairs.get(info.action);
    if (pair == null) {
      pair = { action: info.action };
      pairs.set(info.action, pair);
    }

    if (info.messageType === 'Request' || info.messageType === 'Standalone') {
      pair.request = info;
    } else {
      pair.response = info;
    }
  }

  return pairs;
}
