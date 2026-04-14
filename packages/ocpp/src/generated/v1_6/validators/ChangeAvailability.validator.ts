import type { ValidateFunction } from 'ajv';
import { ajv } from './_ajv.js';

const schema = {
  "title": "ChangeAvailabilityRequest",
  "type": "object",
  "properties": {
    "connectorId": {
      "type": "integer"
    },
    "type": {
      "type": "string",
      "additionalProperties": false,
      "enum": [
        "Inoperative",
        "Operative"
      ]
    }
  },
  "additionalProperties": false,
  "required": [
    "connectorId",
    "type"
  ]
} as const;

export const validateChangeAvailability: ValidateFunction = ajv.compile(schema);
