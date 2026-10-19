import type { ValidateFunction } from 'ajv';
import { ajv } from './_ajv.js';
import { ajvFit } from './_ajv-fit.js';

const schema = {
  "$id": "urn:OCPP:Cp:2:2020:3:FirmwareStatusNotificationRequest",
  "comment": "OCPP 2.0.1 FINAL",
  "definitions": {
    "CustomDataType": {
      "description": "This class does not get 'AdditionalProperties = false' in the schema generation, so it can be extended with arbitrary JSON properties to allow adding custom data.",
      "javaType": "CustomData",
      "type": "object",
      "properties": {
        "vendorId": {
          "type": "string",
          "maxLength": 255
        }
      },
      "required": [
        "vendorId"
      ]
    },
    "FirmwareStatusEnumType": {
      "description": "This contains the progress status of the firmware installation.\r\n",
      "javaType": "FirmwareStatusEnum",
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
    }
  },
  "type": "object",
  "additionalProperties": false,
  "properties": {
    "customData": {
      "$ref": "#/definitions/CustomDataType"
    },
    "status": {
      "$ref": "#/definitions/FirmwareStatusEnumType"
    },
    "requestId": {
      "description": "The request id that was provided in the\r\nUpdateFirmwareRequest that started this firmware update.\r\nThis field is mandatory, unless the message was triggered by a TriggerMessageRequest AND there is no firmware update ongoing.\r\n",
      "type": "integer"
    }
  },
  "required": [
    "status"
  ]
} as const;

export const validateFirmwareStatusNotificationRequest: ValidateFunction = ajv.compile(schema);

const removeAdditionalFirmwareStatusNotificationRequest: ValidateFunction = ajvFit.compile(schema);

/**
 * Returns a deep copy of the payload without the properties this schema does not allow.
 * The input is not changed. The copy is not validated: call validateFirmwareStatusNotificationRequest for that.
 */
export function fitFirmwareStatusNotificationRequest(payload: Record<string, unknown>): Record<string, unknown> {
  const copy = structuredClone(payload);
  removeAdditionalFirmwareStatusNotificationRequest(copy);
  return copy;
}
