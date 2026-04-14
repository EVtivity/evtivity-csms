import type { ValidateFunction } from 'ajv';
import { ajv } from './_ajv.js';

const schema = {
  "title": "StopTransactionResponse",
  "type": "object",
  "properties": {
    "idTagInfo": {
      "type": "object",
      "properties": {
        "expiryDate": {
          "type": "string",
          "format": "date-time"
        },
        "parentIdTag": {
          "type": "string",
          "maxLength": 20
        },
        "status": {
          "type": "string",
          "additionalProperties": false,
          "enum": [
            "Accepted",
            "Blocked",
            "Expired",
            "Invalid",
            "ConcurrentTx"
          ]
        }
      },
      "additionalProperties": false,
      "required": [
        "status"
      ]
    }
  },
  "additionalProperties": false
} as const;

export const validateStopTransactionResponse: ValidateFunction = ajv.compile(schema);
