export interface ConfigurationKeyType {
  key: string;
  readonly: boolean;
  value?: string;
}

export interface GetConfigurationResponse {
  configurationKey?: ConfigurationKeyType[];
  unknownKey?: string[];
}
