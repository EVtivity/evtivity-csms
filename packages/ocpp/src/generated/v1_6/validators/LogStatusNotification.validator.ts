import type { ValidateFunction } from 'ajv';
import { ajv } from './_ajv.js';

const schema = {
  "title": "LogStatusNotificationRequest",
  "type": "object",
  "properties": {
    "status": {
      "type": "string",
      "additionalProperties": false,
      "enum": [
        "BadMessage",
        "Idle",
        "NotSupportedOperation",
        "PermissionDenied",
        "Uploaded",
        "UploadFailure",
        "Uploading"
      ]
    },
    "requestId": {
      "type": "integer"
    }
  },
  "additionalProperties": false,
  "required": [
    "status"
  ]
} as const;

export const validateLogStatusNotification: ValidateFunction = ajv.compile(schema);
