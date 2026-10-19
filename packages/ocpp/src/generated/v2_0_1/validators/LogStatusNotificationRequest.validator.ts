import type { ValidateFunction } from 'ajv';
import { ajv } from './_ajv.js';
import { ajvFit } from './_ajv-fit.js';

const schema = {
  "$id": "urn:OCPP:Cp:2:2020:3:LogStatusNotificationRequest",
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
    "UploadLogStatusEnumType": {
      "description": "This contains the status of the log upload.\r\n",
      "javaType": "UploadLogStatusEnum",
      "type": "string",
      "additionalProperties": false,
      "enum": [
        "BadMessage",
        "Idle",
        "NotSupportedOperation",
        "PermissionDenied",
        "Uploaded",
        "UploadFailure",
        "Uploading",
        "AcceptedCanceled"
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
      "$ref": "#/definitions/UploadLogStatusEnumType"
    },
    "requestId": {
      "description": "The request id that was provided in GetLogRequest that started this log upload. This field is mandatory,\r\nunless the message was triggered by a TriggerMessageRequest AND there is no log upload ongoing.\r\n",
      "type": "integer"
    }
  },
  "required": [
    "status"
  ]
} as const;

export const validateLogStatusNotificationRequest: ValidateFunction = ajv.compile(schema);

const removeAdditionalLogStatusNotificationRequest: ValidateFunction = ajvFit.compile(schema);

/**
 * Returns a deep copy of the payload without the properties this schema does not allow.
 * The input is not changed. The copy is not validated: call validateLogStatusNotificationRequest for that.
 */
export function fitLogStatusNotificationRequest(payload: Record<string, unknown>): Record<string, unknown> {
  const copy = structuredClone(payload);
  removeAdditionalLogStatusNotificationRequest(copy);
  return copy;
}
