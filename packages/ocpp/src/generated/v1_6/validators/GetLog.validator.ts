import type { ValidateFunction } from 'ajv';
import { ajv } from './_ajv.js';

const schema = {
  "title": "GetLogRequest",
  "type": "object",
  "properties": {
    "logType": {
      "type": "string",
      "additionalProperties": false,
      "enum": [
        "DiagnosticsLog",
        "SecurityLog"
      ]
    },
    "requestId": {
      "type": "integer"
    },
    "retries": {
      "type": "integer"
    },
    "retryInterval": {
      "type": "integer"
    },
    "log": {
      "type": "object",
      "properties": {
        "remoteLocation": {
          "type": "string",
          "maxLength": 512
        },
        "oldestTimestamp": {
          "type": "string",
          "format": "date-time"
        },
        "latestTimestamp": {
          "type": "string",
          "format": "date-time"
        }
      },
      "additionalProperties": false,
      "required": [
        "remoteLocation"
      ]
    }
  },
  "additionalProperties": false,
  "required": [
    "logType",
    "requestId",
    "log"
  ]
} as const;

export const validateGetLog: ValidateFunction = ajv.compile(schema);
