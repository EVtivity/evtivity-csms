import type { ValidateFunction } from 'ajv';
import { ajv } from './_ajv.js';

const schema = {
  "title": "FirmwareStatusNotificationRequest",
  "type": "object",
  "properties": {
    "status": {
      "type": "string",
      "additionalProperties": false,
      "enum": [
        "Downloaded",
        "DownloadFailed",
        "Downloading",
        "Idle",
        "InstallationFailed",
        "Installing",
        "Installed"
      ]
    }
  },
  "additionalProperties": false,
  "required": [
    "status"
  ]
} as const;

export const validateFirmwareStatusNotification: ValidateFunction = ajv.compile(schema);
