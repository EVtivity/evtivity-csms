import type { ValidateFunction } from 'ajv';
import { ajv } from './_ajv.js';

const schema = {
  "title": "DiagnosticsStatusNotificationRequest",
  "type": "object",
  "properties": {
    "status": {
      "type": "string",
      "additionalProperties": false,
      "enum": [
        "Idle",
        "Uploaded",
        "UploadFailed",
        "Uploading"
      ]
    }
  },
  "additionalProperties": false,
  "required": [
    "status"
  ]
} as const;

export const validateDiagnosticsStatusNotification: ValidateFunction = ajv.compile(schema);
