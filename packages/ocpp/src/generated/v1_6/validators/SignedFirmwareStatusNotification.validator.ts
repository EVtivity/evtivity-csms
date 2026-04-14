import type { ValidateFunction } from 'ajv';
import { ajv } from './_ajv.js';

const schema = {
  "title": "SignedFirmwareStatusNotificationRequest",
  "type": "object",
  "properties": {
    "status": {
      "type": "string",
      "additionalProperties": false,
      "enum": [
        "Downloaded",
        "DownloadFailed",
        "Downloading",
        "DownloadScheduled",
        "DownloadPaused",
        "Idle",
        "InstallationFailed",
        "Installing",
        "Installed",
        "InstallRebooting",
        "InstallScheduled",
        "InstallVerificationFailed",
        "InvalidSignature",
        "SignatureVerified"
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

export const validateSignedFirmwareStatusNotification: ValidateFunction = ajv.compile(schema);
