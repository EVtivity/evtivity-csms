# AI data handling

What each AI surface sends to the model provider: never sent, masked or hashed, or sent as is. The AI data note (Settings > AI, the portal driver AI consent notice, the website AI docs) is written from this table and may never claim more. This file is the one copy of the table, the note texts and the note claims: `ai-data-handling-guard.test.ts` (TC-AI-AD-11) and the CSMS and portal locale tests (TC-AI-AD-13) read it.

## Surface table

Each row is one path to the provider. `Usage surface` is the `AI_USAGE_SURFACES` value it is charged to (`none` for MCP, which calls no model). The category words in the cells are the ones the note uses (TC-AI-AD-11 checks them).

| Surface               | Usage surface         | Level     | Never sent                                                                                   | Masked or hashed                                                                   | Sent as is                                                                                                                                                                                                   | Test                                       |
| --------------------- | --------------------- | --------- | -------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------ |
| `chatbot`             | `chatbot`             | `chatbot` | stored credentials, station passwords, secret-shaped values (typed text and tool results)    | card numbers, IBANs                                                                | driver contact details (names, email addresses, phone numbers, token ids) from reads the operator may run (RBAC, site scope), station, session and site data, the operator's typed text, the operator's name | TC-AI-AD-01                                |
| `chatbot-attachments` | `chatbot`             | `chatbot` | secret-shaped values in text files (`text/plain`, `text/csv`, JSON, NDJSON) and file names   | card numbers, IBANs (in text files)                                                | images and PDFs as uploaded, the rest of a text file                                                                                                                                                         | TC-AI-AD-02                                |
| `explain-block`       | `chatbot`             | `support` | stored credentials, station passwords, secret-shaped values                                  | card numbers, IBANs, email addresses, phone numbers, token ids                     | the record's whitelisted fields, its evidence pack, the latest insight (site counts only). Typed text and tool reads of an Explain conversation are the `chatbot` row                                        | TC-AI-AD-05                                |
| `mcp`                 | `none`                | `chatbot` | stored credentials, station passwords, secret-shaped values (tool results to the MCP client) | card numbers, IBANs                                                                | driver contact details from reads the API key may run, station, session and site data                                                                                                                        | TC-AI-AD-08                                |
| `support`             | `support`             | `support` | stored credentials, station passwords, secret-shaped values                                  | card numbers, IBANs, email addresses, phone numbers, token ids                     | driver names, case text and messages (framed untrusted), the case's station, session, payment status and OCPP logs, fresh insights of the case, the driver's language                                        | TC-AI-AD-03                                |
| `insight`             | `insight`             | `support` | stored credentials, station passwords, secret-shaped values                                  | card numbers, IBANs, email addresses, phone numbers, token ids                     | evidence collector fields: station ids, statuses, OCPP error codes, station-supplied text (framed), session times, energy, costs, payment status, refusal reasons, site counts                               | TC-AI-AD-04                                |
| `insight_translation` | `insight_translation` | `support` | stored credentials, station passwords, secret-shaped values, any evidence                    | card numbers, IBANs, email addresses, phone numbers, token ids                     | the stored insight summary (model output), framed                                                                                                                                                            | TC-AI-AD-06                                |
| `worker`              | `worker`              | `support` | stored credentials, station passwords, secret-shaped values                                  | card numbers, IBANs, email addresses, phone numbers, token ids                     | site names, station ids, transaction ids, counts, durations, tariff finding types                                                                                                                            | TC-AI-AD-07                                |
| `driver_support`      | `driver_support`      | `driver`  | stored credentials, station passwords, secret-shaped values                                  | card numbers, IBANs, email addresses, phone numbers, token ids (last 4 characters) | the driver's own sessions, payments, reservations, stations used and case text (lane D1 evidence pack, `services/src/ai-evidence/driver.ts`)                                                                 | TC-AI-AD-09 (boundary; D1 journey pending) |

Every surface also sends its system prompt: server rules, the operator's surface prompt, the docs index, the date, the company currency, the operator's name (chatbot and support) and the answer language.

## Note text

The note shown in Settings > AI (`AiDataNotice`, on Providers and keys and every surface tab: Assistant, Support drafts, Driver support, Automatic insights, Background workers, MCP; not on Usage and limits), the portal driver AI consent notice and the website AI docs. Locale keys `ai.dataNotice.*` (6 CSMS locales; the portal and the app show only the driver note). English source:

```note
Messages, tool results and attachments are sent to the selected AI provider. Check the provider's data retention terms. The AI provider never receives stored credentials, such as passwords, API keys, secrets and station passwords. Card numbers are cut to their last 4 characters. Support drafts, automatic insights, background workers and driver support also mask email addresses and phone numbers, and hash or shorten driver token ids. The assistant sends driver contact details as stored, only to users allowed to read them. Text you type and text files you attach are checked for keys and card numbers. Images and PDFs you attach are sent as they are.
```

### Driver note

The driver variant, shown on the portal and app consent step under the notice. Locale keys `supportCases.ai.dataNotice.*` (portal, 6 locales) and `support.ai.dataNotice.*` (mobile, 6 locales). It claims only what the `driver_support` row holds: TC-AI-AD-11 checks every category word against the claims that name `driver_support`, and every data word against that row's sent column; the portal locale test compares the English text. The operator note (`ai.dataNotice.*`) stays for the CSMS.

```note-driver
The AI reads your request and your own charging sessions, payments, reservations and the stations you used. Stored credentials, such as passwords, are never sent. Card numbers are cut to their last 4 characters. Email addresses and phone numbers are masked. Charging card and token ids are shortened to their last 4 characters.
```

## Note claims

Each claim names a category, the column it is in, and the rows it holds for. TC-AI-AD-11 checks every claim against the table and every category word in the note against the claims.

- never: stored credentials | chatbot, explain-block, mcp, support, insight, insight_translation, worker, driver_support
- never: station passwords | chatbot, explain-block, mcp, support, insight, insight_translation, worker, driver_support
- never: secret-shaped values | chatbot, chatbot-attachments, explain-block, mcp, support, insight, insight_translation, worker, driver_support
- masked: card numbers | chatbot, chatbot-attachments, explain-block, mcp, support, insight, insight_translation, worker, driver_support
- masked: IBANs | chatbot, chatbot-attachments, explain-block, mcp, support, insight, insight_translation, worker, driver_support
- masked: email addresses | explain-block, support, insight, insight_translation, worker, driver_support
- masked: phone numbers | explain-block, support, insight, insight_translation, worker, driver_support
- masked: token ids | explain-block, support, insight, insight_translation, worker, driver_support
- as is: driver contact details | chatbot, mcp
- as is: images and PDFs | chatbot-attachments
