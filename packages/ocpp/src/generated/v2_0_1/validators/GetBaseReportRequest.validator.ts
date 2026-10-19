import type { ValidateFunction } from 'ajv';
import { ajv } from './_ajv.js';
import { ajvFit } from './_ajv-fit.js';

const schema = {
  "$id": "urn:OCPP:Cp:2:2020:3:GetBaseReportRequest",
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
    "ReportBaseEnumType": {
      "description": "This field specifies the report base.\r\n",
      "javaType": "ReportBaseEnum",
      "type": "string",
      "additionalProperties": false,
      "enum": [
        "ConfigurationInventory",
        "FullInventory",
        "SummaryInventory"
      ]
    }
  },
  "type": "object",
  "additionalProperties": false,
  "properties": {
    "customData": {
      "$ref": "#/definitions/CustomDataType"
    },
    "requestId": {
      "description": "The Id of the request.\r\n",
      "type": "integer"
    },
    "reportBase": {
      "$ref": "#/definitions/ReportBaseEnumType"
    }
  },
  "required": [
    "requestId",
    "reportBase"
  ]
} as const;

export const validateGetBaseReportRequest: ValidateFunction = ajv.compile(schema);

const removeAdditionalGetBaseReportRequest: ValidateFunction = ajvFit.compile(schema);

/**
 * Returns a deep copy of the payload without the properties this schema does not allow.
 * The input is not changed. The copy is not validated: call validateGetBaseReportRequest for that.
 */
export function fitGetBaseReportRequest(payload: Record<string, unknown>): Record<string, unknown> {
  const copy = structuredClone(payload);
  removeAdditionalGetBaseReportRequest(copy);
  return copy;
}
