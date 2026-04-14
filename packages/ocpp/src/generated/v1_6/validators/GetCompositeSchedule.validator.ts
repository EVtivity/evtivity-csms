import type { ValidateFunction } from 'ajv';
import { ajv } from './_ajv.js';

const schema = {
  "title": "GetCompositeScheduleRequest",
  "type": "object",
  "properties": {
    "connectorId": {
      "type": "integer"
    },
    "duration": {
      "type": "integer"
    },
    "chargingRateUnit": {
      "type": "string",
      "additionalProperties": false,
      "enum": [
        "A",
        "W"
      ]
    }
  },
  "additionalProperties": false,
  "required": [
    "connectorId",
    "duration"
  ]
} as const;

export const validateGetCompositeSchedule: ValidateFunction = ajv.compile(schema);
