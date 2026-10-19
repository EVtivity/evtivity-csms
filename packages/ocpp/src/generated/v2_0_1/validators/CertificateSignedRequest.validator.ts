import type { ValidateFunction } from 'ajv';
import { ajv } from './_ajv.js';
import { ajvFit } from './_ajv-fit.js';

const schema = {
  "$id": "urn:OCPP:Cp:2:2020:3:CertificateSignedRequest",
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
    "CertificateSigningUseEnumType": {
      "description": "Indicates the type of the signed certificate that is returned. When omitted the certificate is used for both the 15118 connection (if implemented) and the Charging Station to CSMS connection. This field is required when a typeOfCertificate was included in the &lt;&lt;signcertificaterequest,SignCertificateRequest&gt;&gt; that requested this certificate to be signed AND both the 15118 connection and the Charging Station connection are implemented.\r\n\r\n",
      "javaType": "CertificateSigningUseEnum",
      "type": "string",
      "additionalProperties": false,
      "enum": [
        "ChargingStationCertificate",
        "V2GCertificate"
      ]
    }
  },
  "type": "object",
  "additionalProperties": false,
  "properties": {
    "customData": {
      "$ref": "#/definitions/CustomDataType"
    },
    "certificateChain": {
      "description": "The signed PEM encoded X.509 certificate. This can also contain the necessary sub CA certificates. In that case, the order of the bundle should follow the certificate chain, starting from the leaf certificate.\r\n\r\nThe Configuration Variable &lt;&lt;configkey-max-certificate-chain-size,MaxCertificateChainSize&gt;&gt; can be used to limit the maximum size of this field.\r\n",
      "type": "string",
      "maxLength": 10000
    },
    "certificateType": {
      "$ref": "#/definitions/CertificateSigningUseEnumType"
    }
  },
  "required": [
    "certificateChain"
  ]
} as const;

export const validateCertificateSignedRequest: ValidateFunction = ajv.compile(schema);

const removeAdditionalCertificateSignedRequest: ValidateFunction = ajvFit.compile(schema);

/**
 * Returns a deep copy of the payload without the properties this schema does not allow.
 * The input is not changed. The copy is not validated: call validateCertificateSignedRequest for that.
 */
export function fitCertificateSignedRequest(payload: Record<string, unknown>): Record<string, unknown> {
  const copy = structuredClone(payload);
  removeAdditionalCertificateSignedRequest(copy);
  return copy;
}
