import type { ValidateFunction } from 'ajv';
import { ajv } from './_ajv.js';
import { ajvFit } from './_ajv-fit.js';

const schema = {
  "$id": "urn:OCPP:Cp:2:2020:3:PublishFirmwareStatusNotificationRequest",
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
    "PublishFirmwareStatusEnumType": {
      "description": "This contains the progress status of the publishfirmware\r\ninstallation.\r\n",
      "javaType": "PublishFirmwareStatusEnum",
      "type": "string",
      "additionalProperties": false,
      "enum": [
        "Idle",
        "DownloadScheduled",
        "Downloading",
        "Downloaded",
        "Published",
        "DownloadFailed",
        "DownloadPaused",
        "InvalidChecksum",
        "ChecksumVerified",
        "PublishFailed"
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
      "$ref": "#/definitions/PublishFirmwareStatusEnumType"
    },
    "location": {
      "description": "Required if status is Published. Can be multiple URI’s, if the Local Controller supports e.g. HTTP, HTTPS, and FTP.\r\n",
      "type": "array",
      "additionalItems": false,
      "items": {
        "type": "string",
        "maxLength": 512
      },
      "minItems": 1
    },
    "requestId": {
      "description": "The request id that was\r\nprovided in the\r\nPublishFirmwareRequest which\r\ntriggered this action.\r\n",
      "type": "integer"
    }
  },
  "required": [
    "status"
  ]
} as const;

export const validatePublishFirmwareStatusNotificationRequest: ValidateFunction = ajv.compile(schema);

const removeAdditionalPublishFirmwareStatusNotificationRequest: ValidateFunction = ajvFit.compile(schema);

/**
 * Returns a deep copy of the payload without the properties this schema does not allow.
 * The input is not changed. The copy is not validated: call validatePublishFirmwareStatusNotificationRequest for that.
 */
export function fitPublishFirmwareStatusNotificationRequest(payload: Record<string, unknown>): Record<string, unknown> {
  const copy = structuredClone(payload);
  removeAdditionalPublishFirmwareStatusNotificationRequest(copy);
  return copy;
}
