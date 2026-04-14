import type { ValidateFunction } from 'ajv';
import { ajv } from './_ajv.js';

const schema = {
  "title": "ExtendedTriggerMessageRequest",
  "type": "object",
  "properties": {
    "requestedMessage": {
      "type": "string",
      "additionalProperties": false,
      "enum": [
        "BootNotification",
        "LogStatusNotification",
        "FirmwareStatusNotification",
        "Heartbeat",
        "MeterValues",
        "SignChargePointCertificate",
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

export const validateExtendedTriggerMessage: ValidateFunction = ajv.compile(schema);
