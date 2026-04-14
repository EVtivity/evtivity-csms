// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import {
  pgTable,
  serial,
  text,
  varchar,
  timestamp,
  index,
  numeric,
  integer,
} from 'drizzle-orm/pg-core';
import { users } from './identity.js';

export const chatbotAiConfigs = pgTable(
  'chatbot_ai_configs',
  {
    id: serial('id').primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' })
      .unique(),
    provider: varchar('provider', { length: 20 }).notNull(),
    apiKeyEnc: text('api_key_enc').notNull(),
    model: varchar('model', { length: 100 }),
    temperature: numeric('temperature'),
    topP: numeric('top_p'),
    topK: integer('top_k'),
    systemPrompt: text('system_prompt'),
    supportAiProvider: varchar('support_ai_provider', { length: 20 }),
    supportAiApiKeyEnc: text('support_ai_api_key_enc'),
    supportAiModel: varchar('support_ai_model', { length: 100 }),
    supportAiTemperature: numeric('support_ai_temperature'),
    supportAiTopP: numeric('support_ai_top_p'),
    supportAiTopK: integer('support_ai_top_k'),
    supportAiSystemPrompt: text('support_ai_system_prompt'),
    supportAiTone: varchar('support_ai_tone', { length: 20 }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index('idx_chatbot_ai_configs_user').on(table.userId)],
);
