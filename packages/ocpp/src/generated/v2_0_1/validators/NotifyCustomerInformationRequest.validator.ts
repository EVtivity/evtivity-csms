import type { ValidateFunction } from 'ajv';
import { ajv } from './_ajv.js';
import { ajvFit } from './_ajv-fit.js';

const schema = {
  "$id": "urn:OCPP:Cp:2:2020:3:NotifyCustomerInformationRequest",
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
    }
  },
  "type": "object",
  "additionalProperties": false,
  "properties": {
    "customData": {
      "$ref": "#/definitions/CustomDataType"
    },
    "data": {
      "description": "(Part of) the requested data. No format specified in which the data is returned. Should be human readable.\r\n",
      "type": "string",
      "maxLength": 512
    },
    "tbc": {
      "description": "“to be continued” indicator. Indicates whether another part of the monitoringData follows in an upcoming notifyMonitoringReportRequest message. Default value when omitted is false.\r\n",
      "type": "boolean",
      "default": false
    },
    "seqNo": {
      "description": "Sequence number of this message. First message starts at 0.\r\n",
      "type": "integer"
    },
    "generatedAt": {
      "description": " Timestamp of the moment this message was generated at the Charging Station.\r\n",
      "type": "string",
      "format": "date-time"
    },
    "requestId": {
      "description": "The Id of the request.\r\n\r\n",
      "type": "integer"
    }
  },
  "required": [
    "data",
    "seqNo",
    "generatedAt",
    "requestId"
  ]
} as const;

export const validateNotifyCustomerInformationRequest: ValidateFunction = ajv.compile(schema);

const removeAdditionalNotifyCustomerInformationRequest: ValidateFunction = ajvFit.compile(schema);

/**
 * Returns a deep copy of the payload without the properties this schema does not allow.
 * The input is not changed. The copy is not validated: call validateNotifyCustomerInformationRequest for that.
 */
export function fitNotifyCustomerInformationRequest(payload: Record<string, unknown>): Record<string, unknown> {
  const copy = structuredClone(payload);
  removeAdditionalNotifyCustomerInformationRequest(copy);
  return copy;
}
