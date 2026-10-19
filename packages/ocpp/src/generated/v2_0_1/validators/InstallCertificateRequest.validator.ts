import type { ValidateFunction } from 'ajv';
import { ajv } from './_ajv.js';
import { ajvFit } from './_ajv-fit.js';

const schema = {
  "$id": "urn:OCPP:Cp:2:2020:3:InstallCertificateRequest",
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
    "InstallCertificateUseEnumType": {
      "description": "Indicates the certificate type that is sent.\r\n",
      "javaType": "InstallCertificateUseEnum",
      "type": "string",
      "additionalProperties": false,
      "enum": [
        "V2GRootCertificate",
        "MORootCertificate",
        "CSMSRootCertificate",
        "ManufacturerRootCertificate"
      ]
    }
  },
  "type": "object",
  "additionalProperties": false,
  "properties": {
    "customData": {
      "$ref": "#/definitions/CustomDataType"
    },
    "certificateType": {
      "$ref": "#/definitions/InstallCertificateUseEnumType"
    },
    "certificate": {
      "description": "A PEM encoded X.509 certificate.\r\n",
      "type": "string",
      "maxLength": 5500
    }
  },
  "required": [
    "certificateType",
    "certificate"
  ]
} as const;

export const validateInstallCertificateRequest: ValidateFunction = ajv.compile(schema);

const removeAdditionalInstallCertificateRequest: ValidateFunction = ajvFit.compile(schema);

/**
 * Returns a deep copy of the payload without the properties this schema does not allow.
 * The input is not changed. The copy is not validated: call validateInstallCertificateRequest for that.
 */
export function fitInstallCertificateRequest(payload: Record<string, unknown>): Record<string, unknown> {
  const copy = structuredClone(payload);
  removeAdditionalInstallCertificateRequest(copy);
  return copy;
}
