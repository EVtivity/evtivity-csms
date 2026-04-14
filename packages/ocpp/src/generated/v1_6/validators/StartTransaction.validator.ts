import type { ValidateFunction } from 'ajv';
import { ajv } from './_ajv.js';

const schema = {
  "title": "StartTransactionRequest",
  "type": "object",
  "properties": {
    "connectorId": {
      "type": "integer"
    },
    "idTag": {
      "type": "string",
      "maxLength": 20
    },
    "meterStart": {
      "type": "integer"
    },
    "reservationId": {
      "type": "integer"
    },
    "timestamp": {
      "type": "string",
      "format": "date-time"
    }
  },
  "additionalProperties": false,
  "required": [
    "connectorId",
    "idTag",
    "meterStart",
    "timestamp"
  ]
} as const;

export const validateStartTransaction: ValidateFunction = ajv.compile(schema);
