import type { ValidateFunction } from 'ajv';
import { ajv } from './_ajv.js';

const schema = {
  "title": "CancelReservationRequest",
  "type": "object",
  "properties": {
    "reservationId": {
      "type": "integer"
    }
  },
  "additionalProperties": false,
  "required": [
    "reservationId"
  ]
} as const;

export const validateCancelReservation: ValidateFunction = ajv.compile(schema);
