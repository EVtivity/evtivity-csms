import type { ValidateFunction } from 'ajv';
import { ajv } from './_ajv.js';

const schema = {
  "title": "ReserveNowRequest",
  "type": "object",
  "properties": {
    "connectorId": {
      "type": "integer"
    },
    "expiryDate": {
      "type": "string",
      "format": "date-time"
    },
    "idTag": {
      "type": "string",
      "maxLength": 20
    },
    "parentIdTag": {
      "type": "string",
      "maxLength": 20
    },
    "reservationId": {
      "type": "integer"
    }
  },
  "additionalProperties": false,
  "required": [
    "connectorId",
    "expiryDate",
    "idTag",
    "reservationId"
  ]
} as const;

export const validateReserveNow: ValidateFunction = ajv.compile(schema);
