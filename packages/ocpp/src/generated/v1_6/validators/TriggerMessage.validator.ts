import type { ValidateFunction } from 'ajv';
import { ajv } from './_ajv.js';

const schema = {
  "title": "TriggerMessageRequest",
  "type": "object",
  "properties": {
    "requestedMessage": {
      "type": "string",
      "additionalProperties": false,
      "enum": [
        "BootNotification",
        "DiagnosticsStatusNotification",
        "FirmwareStatusNotification",
        "Heartbeat",
        "MeterValues",
        "StatusNotification"
      ]
    },
    "connectorId": {
      "type": "integer"
    }
  },
  "additionalProperties": false,
  "required": [
    "requestedMessage"
  ]
} as const;

export const validateTriggerMessage: ValidateFunction = ajv.compile(schema);
