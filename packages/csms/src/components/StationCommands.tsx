// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { useState, useCallback } from 'react';
import { useMutation } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select } from '@/components/ui/select';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from '@/components/ui/dialog';
import { api } from '@/lib/api';
import { useOcppSchema } from '@/hooks/use-ocpp-schema';
import { resolveFields, formValuesToPayload, generateJsonStub } from '@/lib/ocpp-schema';
import { SchemaForm } from '@/components/SchemaForm';
import { OCPP_21_VARIABLES } from '@/lib/ocpp-variables';

const RESET_TYPES = ['Immediate', 'OnIdle'] as const;

const RESET_TYPES_16 = ['Hard', 'Soft'] as const;

const ID_TOKEN_TYPES = [
  'Central',
  'eMAID',
  'ISO14443',
  'ISO15693',
  'KeyCode',
  'Local',
  'MacAddress',
  'NoAuthorization',
] as const;

const TRIGGER_MESSAGE_TYPES = [
  'BootNotification',
  'Heartbeat',
  'MeterValues',
  'StatusNotification',
  'FirmwareStatusNotification',
  'LogStatusNotification',
  'TransactionEvent',
  'SignChargingStationCertificate',
  'PublishFirmwareStatusNotification',
] as const;

const TRIGGER_MESSAGE_TYPES_16 = [
  'BootNotification',
  'DiagnosticsStatusNotification',
  'FirmwareStatusNotification',
  'Heartbeat',
  'MeterValues',
  'StatusNotification',
] as const;

const CSMS_ACTIONS = [
  'AdjustPeriodicEventStream',
  'AFRRSignal',
  'CancelReservation',
  'CertificateSigned',
  'ChangeAvailability',
  'ChangeTransactionTariff',
  'ClearCache',
  'ClearChargingProfile',
  'ClearDERControl',
  'ClearDisplayMessage',
  'ClearTariffs',
  'ClearVariableMonitoring',
  'ClosePeriodicEventStream',
  'CostUpdated',
  'CustomerInformation',
  'DataTransfer',
  'DeleteCertificate',
  'Get15118EVCertificate',
  'GetBaseReport',
  'GetCertificateChainStatus',
  'GetChargingProfiles',
  'GetCompositeSchedule',
  'GetDERControl',
  'GetDisplayMessages',
  'GetInstalledCertificateIds',
  'GetLocalListVersion',
  'GetLog',
  'GetMonitoringReport',
  'GetPeriodicEventStream',
  'GetReport',
  'GetTariffs',
  'GetVariables',
  'InstallCertificate',
  'OpenPeriodicEventStream',
  'PublishFirmware',
  'RequestBatterySwap',
  'RequestStartTransaction',
  'RequestStopTransaction',
  'ReserveNow',
  'Reset',
  'SendLocalList',
  'SetChargingProfile',
  'SetDERControl',
  'SetDefaultTariff',
  'SetDisplayMessage',
  'SetMonitoringBase',
  'SetMonitoringLevel',
  'SetNetworkProfile',
  'SetVariableMonitoring',
  'SetVariables',
  'TriggerMessage',
  'UnlockConnector',
  'UnpublishFirmware',
  'UpdateDynamicSchedule',
  'UpdateFirmware',
  'UsePriorityCharging',
] as const;

const CSMS_ACTIONS_16 = [
  'CancelReservation',
  'ChangeAvailability',
  'ChangeConfiguration',
  'ClearCache',
  'ClearChargingProfile',
  'DataTransfer',
  'GetCompositeSchedule',
  'GetConfiguration',
  'GetDiagnostics',
  'GetLocalListVersion',
  'RemoteStartTransaction',
  'RemoteStopTransaction',
  'ReserveNow',
  'Reset',
  'SendLocalList',
  'SetChargingProfile',
  'TriggerMessage',
  'UnlockConnector',
  'UpdateFirmware',
] as const;

interface CommandResponse {
  status: string;
  stationId: string;
  action: string;
  response?: Record<string, unknown>;
  error?: string;
}

interface StationCommandsProps {
  stationId: string;
  ocppProtocol: string | null;
}

type QuickAction =
  | 'Reset'
  | 'ChangeAvailability'
  | 'UnlockConnector'
  | 'RequestStartTransaction'
  | 'RequestStopTransaction'
  | 'TriggerMessage'
  | 'ClearCache'
  | 'GetVariables'
  | 'SetVariables'
  | 'UpdateFirmware';

type QuickAction16 =
  | 'Reset'
  | 'ChangeAvailability'
  | 'UnlockConnector'
  | 'RemoteStartTransaction'
  | 'RemoteStopTransaction'
  | 'TriggerMessage'
  | 'ClearCache'
  | 'GetConfiguration'
  | 'ChangeConfiguration'
  | 'UpdateFirmware';

interface FormState {
  resetType: string;
  operationalStatus: string;
  evseId: string;
  connectorId: string;
  idToken: string;
  idTokenType: string;
  transactionId: string;
  triggerMessage: string;
  componentName: string;
  variableName: string;
  variableValue: string;
  attributeType: string;
  firmwareUrl: string;
  retrieveDateTime: string;
  configKey: string;
  configValue: string;
  getConfigKey: string;
  firmwareRetries: string;
  firmwareRetryInterval: string;
}

const INITIAL_FORM: FormState = {
  resetType: 'Immediate',
  operationalStatus: 'Operative',
  evseId: '',
  connectorId: '',
  idToken: '',
  idTokenType: 'Central',
  transactionId: '',
  triggerMessage: 'BootNotification',
  componentName: '',
  variableName: '',
  variableValue: '',
  attributeType: 'Actual',
  firmwareUrl: '',
  retrieveDateTime: '',
  configKey: '',
  configValue: '',
  getConfigKey: '',
  firmwareRetries: '',
  firmwareRetryInterval: '',
};

const INITIAL_FORM_16: FormState = {
  ...INITIAL_FORM,
  resetType: 'Hard',
};

const ATTRIBUTE_TYPES = ['Actual', 'Target', 'MinSet', 'MaxSet'] as const;

// Standardized OCPP 2.1 component names
const OCPP_COMPONENTS = Object.keys(OCPP_21_VARIABLES).sort();

// All unique variable names across all components (used when no component is selected)
const ALL_VARIABLES = [...new Set(Object.values(OCPP_21_VARIABLES).flat())].sort();

function buildPayload(action: QuickAction, form: FormState): Record<string, unknown> {
  switch (action) {
    case 'Reset':
      return { type: form.resetType };
    case 'ChangeAvailability': {
      const p: Record<string, unknown> = { operationalStatus: form.operationalStatus };
      if (form.evseId !== '') p['evse'] = { id: Number(form.evseId) };
      return p;
    }
    case 'UnlockConnector':
      return { evseId: Number(form.evseId), connectorId: Number(form.connectorId) };
    case 'RequestStartTransaction': {
      const p: Record<string, unknown> = {
        remoteStartId: Math.floor(Math.random() * 2147483647),
        idToken: { idToken: form.idToken, type: form.idTokenType },
      };
      if (form.evseId !== '') p['evseId'] = Number(form.evseId);
      return p;
    }
    case 'RequestStopTransaction':
      return { transactionId: form.transactionId };
    case 'TriggerMessage': {
      const p: Record<string, unknown> = { requestedMessage: form.triggerMessage };
      if (form.evseId !== '') p['evse'] = { id: Number(form.evseId) };
      return p;
    }
    case 'ClearCache':
      return {};
    case 'GetVariables':
      return {
        getVariableData: [
          {
            attributeType: form.attributeType,
            component: { name: form.componentName },
            variable: { name: form.variableName },
          },
        ],
      };
    case 'SetVariables':
      return {
        setVariableData: [
          {
            attributeType: form.attributeType,
            component: { name: form.componentName },
            variable: { name: form.variableName },
            attributeValue: form.variableValue,
          },
        ],
      };
    case 'UpdateFirmware':
      return {
        firmware: {
          location: form.firmwareUrl,
          retrieveDateTime: new Date(form.retrieveDateTime).toISOString(),
        },
        requestId: Date.now(),
      };
  }
}

function buildPayload16(action: QuickAction16, form: FormState): Record<string, unknown> {
  switch (action) {
    case 'Reset':
      return { type: form.resetType };
    case 'ChangeAvailability': {
      const p: Record<string, unknown> = {
        connectorId: Number(form.connectorId || '0'),
        type: form.operationalStatus,
      };
      return p;
    }
    case 'UnlockConnector':
      return { connectorId: Number(form.connectorId) };
    case 'RemoteStartTransaction': {
      const p: Record<string, unknown> = { idTag: form.idToken };
      if (form.connectorId !== '') p['connectorId'] = Number(form.connectorId);
      return p;
    }
    case 'RemoteStopTransaction':
      return { transactionId: Number(form.transactionId) };
    case 'TriggerMessage': {
      const p: Record<string, unknown> = { requestedMessage: form.triggerMessage };
      if (form.connectorId !== '') p['connectorId'] = Number(form.connectorId);
      return p;
    }
    case 'ClearCache':
      return {};
    case 'GetConfiguration': {
      if (form.getConfigKey !== '') {
        return { key: [form.getConfigKey] };
      }
      return {};
    }
    case 'ChangeConfiguration':
      return { key: form.configKey, value: form.configValue };
    case 'UpdateFirmware': {
      const p: Record<string, unknown> = {
        location: form.firmwareUrl,
        retrieveDate: new Date(form.retrieveDateTime).toISOString(),
      };
      if (form.firmwareRetries !== '') p['retries'] = Number(form.firmwareRetries);
      if (form.firmwareRetryInterval !== '')
        p['retryInterval'] = Number(form.firmwareRetryInterval);
      return p;
    }
  }
}

const QUICK_ACTIONS = [
  { action: 'Reset' as const, labelKey: 'commands.reset' as const },
  { action: 'ChangeAvailability' as const, labelKey: 'commands.changeAvailability' as const },
  { action: 'UnlockConnector' as const, labelKey: 'commands.unlockConnector' as const },
  { action: 'RequestStartTransaction' as const, labelKey: 'commands.startTransaction' as const },
  { action: 'RequestStopTransaction' as const, labelKey: 'commands.stopTransaction' as const },
  { action: 'TriggerMessage' as const, labelKey: 'commands.triggerMessage' as const },
  { action: 'ClearCache' as const, labelKey: 'commands.clearCache' as const },
  { action: 'GetVariables' as const, labelKey: 'commands.getVariables' as const },
  { action: 'SetVariables' as const, labelKey: 'commands.setVariables' as const },
  { action: 'UpdateFirmware' as const, labelKey: 'commands.updateFirmware' as const },
] satisfies { action: QuickAction; labelKey: string }[];

const QUICK_ACTIONS_16 = [
  { action: 'Reset' as const, labelKey: 'commands.reset' as const },
  { action: 'ChangeAvailability' as const, labelKey: 'commands.changeAvailability' as const },
  { action: 'UnlockConnector' as const, labelKey: 'commands.unlockConnector' as const },
  {
    action: 'RemoteStartTransaction' as const,
    labelKey: 'commands.remoteStartTransaction' as const,
  },
  {
    action: 'RemoteStopTransaction' as const,
    labelKey: 'commands.remoteStopTransaction' as const,
  },
  { action: 'TriggerMessage' as const, labelKey: 'commands.triggerMessage' as const },
  { action: 'ClearCache' as const, labelKey: 'commands.clearCache' as const },
  { action: 'GetConfiguration' as const, labelKey: 'commands.getConfiguration' as const },
  { action: 'ChangeConfiguration' as const, labelKey: 'commands.changeConfiguration' as const },
  { action: 'UpdateFirmware' as const, labelKey: 'commands.updateFirmware' as const },
] satisfies { action: QuickAction16; labelKey: string }[];

function QuickActionForm({
  action,
  form,
  onChange,
}: {
  action: QuickAction;
  form: FormState;
  onChange: (patch: Partial<FormState>) => void;
}): React.JSX.Element | null {
  const { t } = useTranslation();

  switch (action) {
    case 'Reset':
      return (
        <div className="space-y-2">
          <Label htmlFor="reset-type-select">{t('commands.type')}</Label>
          <Select
            id="reset-type-select"
            value={form.resetType}
            onChange={(e) => {
              onChange({ resetType: e.target.value });
            }}
            className="h-9"
          >
            {RESET_TYPES.map((rt) => (
              <option key={rt} value={rt}>
                {rt}
              </option>
            ))}
          </Select>
        </div>
      );
    case 'ChangeAvailability':
      return (
        <div className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="operational-status-select">{t('commands.operationalStatus')}</Label>
            <Select
              id="operational-status-select"
              value={form.operationalStatus}
              onChange={(e) => {
                onChange({ operationalStatus: e.target.value });
              }}
              className="h-9"
            >
              <option value="Operative">{t('commands.operative')}</option>
              <option value="Inoperative">{t('commands.inoperative')}</option>
            </Select>
          </div>
          <div className="space-y-2">
            <Label htmlFor="cmd-avail-evse-id">{t('commands.evseIdOptional')}</Label>
            <Input
              id="cmd-avail-evse-id"
              type="number"
              value={form.evseId}
              onChange={(e) => {
                onChange({ evseId: e.target.value });
              }}
              placeholder={t('commands.leaveEmptyForStation')}
            />
          </div>
        </div>
      );
    case 'UnlockConnector':
      return (
        <div className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="cmd-unlock-evse-id">{t('commands.evseId')}</Label>
            <Input
              id="cmd-unlock-evse-id"
              type="number"
              value={form.evseId}
              onChange={(e) => {
                onChange({ evseId: e.target.value });
              }}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="cmd-unlock-connector-id">{t('commands.connectorId')}</Label>
            <Input
              id="cmd-unlock-connector-id"
              type="number"
              value={form.connectorId}
              onChange={(e) => {
                onChange({ connectorId: e.target.value });
              }}
            />
          </div>
        </div>
      );
    case 'RequestStartTransaction':
      return (
        <div className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="cmd-start-id-token">{t('commands.idToken')}</Label>
            <Input
              id="cmd-start-id-token"
              value={form.idToken}
              onChange={(e) => {
                onChange({ idToken: e.target.value });
              }}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="token-type-select">{t('commands.tokenType')}</Label>
            <Select
              id="token-type-select"
              value={form.idTokenType}
              onChange={(e) => {
                onChange({ idTokenType: e.target.value });
              }}
              className="h-9"
            >
              {ID_TOKEN_TYPES.map((tt) => (
                <option key={tt} value={tt}>
                  {tt}
                </option>
              ))}
            </Select>
          </div>
          <div className="space-y-2">
            <Label htmlFor="cmd-start-evse-id">{t('commands.evseIdOptional')}</Label>
            <Input
              id="cmd-start-evse-id"
              type="number"
              value={form.evseId}
              onChange={(e) => {
                onChange({ evseId: e.target.value });
              }}
            />
          </div>
        </div>
      );
    case 'RequestStopTransaction':
      return (
        <div className="space-y-2">
          <Label htmlFor="cmd-stop-transaction-id">{t('commands.transactionId')}</Label>
          <Input
            id="cmd-stop-transaction-id"
            value={form.transactionId}
            onChange={(e) => {
              onChange({ transactionId: e.target.value });
            }}
          />
        </div>
      );
    case 'TriggerMessage':
      return (
        <div className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="trigger-message-select">{t('commands.requestedMessage')}</Label>
            <Select
              id="trigger-message-select"
              value={form.triggerMessage}
              onChange={(e) => {
                onChange({ triggerMessage: e.target.value });
              }}
              className="h-9"
            >
              {TRIGGER_MESSAGE_TYPES.map((tm) => (
                <option key={tm} value={tm}>
                  {tm}
                </option>
              ))}
            </Select>
          </div>
          <div className="space-y-2">
            <Label htmlFor="cmd-trigger-evse-id">
              {t('commands.evseId')} ({t('common.optional')})
            </Label>
            <Input
              id="cmd-trigger-evse-id"
              type="number"
              value={form.evseId}
              onChange={(e) => {
                onChange({ evseId: e.target.value });
              }}
            />
          </div>
        </div>
      );
    case 'ClearCache':
      return <p className="text-sm text-muted-foreground">{t('commands.clearCacheDescription')}</p>;
    case 'GetVariables': {
      const getVarOptions = form.componentName
        ? (OCPP_21_VARIABLES[form.componentName] ?? ALL_VARIABLES)
        : ALL_VARIABLES;
      return (
        <div className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="get-component-name-select">{t('commands.componentName')}</Label>
            <Select
              id="get-component-name-select"
              value={form.componentName}
              onChange={(e) => {
                onChange({ componentName: e.target.value, variableName: '' });
              }}
              className="h-9"
            >
              <option value="">--</option>
              {OCPP_COMPONENTS.map((c) => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
            </Select>
          </div>
          <div className="space-y-2">
            <Label htmlFor="get-variable-name-select">{t('commands.variableName')}</Label>
            <Select
              id="get-variable-name-select"
              value={form.variableName}
              onChange={(e) => {
                onChange({ variableName: e.target.value });
              }}
              className="h-9"
            >
              <option value="">--</option>
              {getVarOptions.map((v) => (
                <option key={v} value={v}>
                  {v}
                </option>
              ))}
            </Select>
          </div>
          <div className="space-y-2">
            <Label htmlFor="get-attribute-type-select">{t('commands.attributeType')}</Label>
            <Select
              id="get-attribute-type-select"
              value={form.attributeType}
              onChange={(e) => {
                onChange({ attributeType: e.target.value });
              }}
              className="h-9"
            >
              {ATTRIBUTE_TYPES.map((a) => (
                <option key={a} value={a}>
                  {a}
                </option>
              ))}
            </Select>
          </div>
        </div>
      );
    }
    case 'SetVariables': {
      const setVarOptions = form.componentName
        ? (OCPP_21_VARIABLES[form.componentName] ?? ALL_VARIABLES)
        : ALL_VARIABLES;
      return (
        <div className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="set-component-name-select">{t('commands.componentName')}</Label>
            <Select
              id="set-component-name-select"
              value={form.componentName}
              onChange={(e) => {
                onChange({ componentName: e.target.value, variableName: '' });
              }}
              className="h-9"
            >
              <option value="">--</option>
              {OCPP_COMPONENTS.map((c) => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
            </Select>
          </div>
          <div className="space-y-2">
            <Label htmlFor="set-variable-name-select">{t('commands.variableName')}</Label>
            <Select
              id="set-variable-name-select"
              value={form.variableName}
              onChange={(e) => {
                onChange({ variableName: e.target.value });
              }}
              className="h-9"
            >
              <option value="">--</option>
              {setVarOptions.map((v) => (
                <option key={v} value={v}>
                  {v}
                </option>
              ))}
            </Select>
          </div>
          <div className="space-y-2">
            <Label htmlFor="set-attribute-type-select">{t('commands.attributeType')}</Label>
            <Select
              id="set-attribute-type-select"
              value={form.attributeType}
              onChange={(e) => {
                onChange({ attributeType: e.target.value });
              }}
              className="h-9"
            >
              {ATTRIBUTE_TYPES.map((a) => (
                <option key={a} value={a}>
                  {a}
                </option>
              ))}
            </Select>
          </div>
          <div className="space-y-2">
            <Label htmlFor="cmd-set-var-value">{t('commands.value')}</Label>
            <Input
              id="cmd-set-var-value"
              value={form.variableValue}
              onChange={(e) => {
                onChange({ variableValue: e.target.value });
              }}
            />
          </div>
        </div>
      );
    }
    case 'UpdateFirmware':
      return (
        <div className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="cmd-fw-url">{t('commands.firmwareLocationUrl')}</Label>
            <Input
              id="cmd-fw-url"
              value={form.firmwareUrl}
              onChange={(e) => {
                onChange({ firmwareUrl: e.target.value });
              }}
              placeholder="https://..."
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="cmd-fw-retrieve-dt">{t('commands.retrieveDateTime')}</Label>
            <Input
              id="cmd-fw-retrieve-dt"
              type="datetime-local"
              value={form.retrieveDateTime}
              onChange={(e) => {
                onChange({ retrieveDateTime: e.target.value });
              }}
            />
          </div>
        </div>
      );
  }
}

function QuickActionForm16({
  action,
  form,
  onChange,
}: {
  action: QuickAction16;
  form: FormState;
  onChange: (patch: Partial<FormState>) => void;
}): React.JSX.Element | null {
  const { t } = useTranslation();

  switch (action) {
    case 'Reset':
      return (
        <div className="space-y-2">
          <Label htmlFor="reset-type-16-select">{t('commands.type')}</Label>
          <Select
            id="reset-type-16-select"
            value={form.resetType}
            onChange={(e) => {
              onChange({ resetType: e.target.value });
            }}
            className="h-9"
          >
            {RESET_TYPES_16.map((rt) => (
              <option key={rt} value={rt}>
                {rt}
              </option>
            ))}
          </Select>
        </div>
      );
    case 'ChangeAvailability':
      return (
        <div className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="cmd16-avail-connector-id">{t('commands.connectorIdRequired')}</Label>
            <Input
              id="cmd16-avail-connector-id"
              type="number"
              value={form.connectorId}
              onChange={(e) => {
                onChange({ connectorId: e.target.value });
              }}
              placeholder="0"
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="availability-type-16-select">{t('commands.type')}</Label>
            <Select
              id="availability-type-16-select"
              value={form.operationalStatus}
              onChange={(e) => {
                onChange({ operationalStatus: e.target.value });
              }}
              className="h-9"
            >
              <option value="Operative">{t('commands.operative')}</option>
              <option value="Inoperative">{t('commands.inoperative')}</option>
            </Select>
          </div>
        </div>
      );
    case 'UnlockConnector':
      return (
        <div className="space-y-2">
          <Label htmlFor="cmd16-unlock-connector-id">{t('commands.connectorIdRequired')}</Label>
          <Input
            id="cmd16-unlock-connector-id"
            type="number"
            value={form.connectorId}
            onChange={(e) => {
              onChange({ connectorId: e.target.value });
            }}
          />
        </div>
      );
    case 'RemoteStartTransaction':
      return (
        <div className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="cmd16-start-id-tag">{t('commands.idTag')}</Label>
            <Input
              id="cmd16-start-id-tag"
              value={form.idToken}
              onChange={(e) => {
                onChange({ idToken: e.target.value });
              }}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="cmd16-start-connector-id">
              {t('commands.connectorId')} ({t('common.optional')})
            </Label>
            <Input
              id="cmd16-start-connector-id"
              type="number"
              value={form.connectorId}
              onChange={(e) => {
                onChange({ connectorId: e.target.value });
              }}
            />
          </div>
        </div>
      );
    case 'RemoteStopTransaction':
      return (
        <div className="space-y-2">
          <Label htmlFor="cmd16-stop-transaction-id">{t('commands.transactionId')}</Label>
          <Input
            id="cmd16-stop-transaction-id"
            type="number"
            value={form.transactionId}
            onChange={(e) => {
              onChange({ transactionId: e.target.value });
            }}
          />
        </div>
      );
    case 'TriggerMessage':
      return (
        <div className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="trigger-message-16-select">{t('commands.requestedMessage')}</Label>
            <Select
              id="trigger-message-16-select"
              value={form.triggerMessage}
              onChange={(e) => {
                onChange({ triggerMessage: e.target.value });
              }}
              className="h-9"
            >
              {TRIGGER_MESSAGE_TYPES_16.map((tm) => (
                <option key={tm} value={tm}>
                  {tm}
                </option>
              ))}
            </Select>
          </div>
          <div className="space-y-2">
            <Label htmlFor="cmd16-trigger-connector-id">
              {t('commands.connectorId')} ({t('common.optional')})
            </Label>
            <Input
              id="cmd16-trigger-connector-id"
              type="number"
              value={form.connectorId}
              onChange={(e) => {
                onChange({ connectorId: e.target.value });
              }}
            />
          </div>
        </div>
      );
    case 'ClearCache':
      return <p className="text-sm text-muted-foreground">{t('commands.clearCacheDescription')}</p>;
    case 'GetConfiguration':
      return (
        <div className="space-y-2">
          <Label htmlFor="cmd16-get-config-key">{t('commands.configKeyOptional')}</Label>
          <Input
            id="cmd16-get-config-key"
            value={form.getConfigKey}
            onChange={(e) => {
              onChange({ getConfigKey: e.target.value });
            }}
          />
        </div>
      );
    case 'ChangeConfiguration':
      return (
        <div className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="cmd16-change-config-key">{t('commands.configKey')}</Label>
            <Input
              id="cmd16-change-config-key"
              value={form.configKey}
              onChange={(e) => {
                onChange({ configKey: e.target.value });
              }}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="cmd16-change-config-value">{t('commands.configValue')}</Label>
            <Input
              id="cmd16-change-config-value"
              value={form.configValue}
              onChange={(e) => {
                onChange({ configValue: e.target.value });
              }}
            />
          </div>
        </div>
      );
    case 'UpdateFirmware':
      return (
        <div className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="cmd16-fw-url">{t('commands.firmwareLocationUrl')}</Label>
            <Input
              id="cmd16-fw-url"
              value={form.firmwareUrl}
              onChange={(e) => {
                onChange({ firmwareUrl: e.target.value });
              }}
              placeholder="https://..."
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="cmd16-fw-retrieve-dt">{t('commands.retrieveDateTime')}</Label>
            <Input
              id="cmd16-fw-retrieve-dt"
              type="datetime-local"
              value={form.retrieveDateTime}
              onChange={(e) => {
                onChange({ retrieveDateTime: e.target.value });
              }}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="cmd16-fw-retries">{t('commands.retries')}</Label>
            <Input
              id="cmd16-fw-retries"
              type="number"
              value={form.firmwareRetries}
              onChange={(e) => {
                onChange({ firmwareRetries: e.target.value });
              }}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="cmd16-fw-retry-interval">{t('commands.retryInterval')}</Label>
            <Input
              id="cmd16-fw-retry-interval"
              type="number"
              value={form.firmwareRetryInterval}
              onChange={(e) => {
                onChange({ firmwareRetryInterval: e.target.value });
              }}
            />
          </div>
        </div>
      );
  }
}

export function StationCommands({
  stationId,
  ocppProtocol,
}: StationCommandsProps): React.JSX.Element {
  const { t } = useTranslation();
  const is16 = ocppProtocol === 'ocpp1.6';

  const [activeAction, setActiveAction] = useState<QuickAction | QuickAction16 | null>(null);
  const [form, setForm] = useState<FormState>(is16 ? INITIAL_FORM_16 : INITIAL_FORM);
  const [result, setResult] = useState<CommandResponse | null>(null);

  const [advancedAction, setAdvancedAction] = useState<string>('');
  const [advancedPayload, setAdvancedPayload] = useState('{}');
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [advancedResult, setAdvancedResult] = useState<CommandResponse | null>(null);
  const [rawMode, setRawMode] = useState(false);
  const [schemaFormValues, setSchemaFormValues] = useState<Record<string, unknown>>({});

  const schemaVersion = is16 ? 'ocpp1.6' : undefined;
  const {
    data: schemaData,
    isLoading: schemaLoading,
    isError: schemaError,
  } = useOcppSchema(advancedAction, schemaVersion);
  const resolvedFields = schemaData != null ? resolveFields(schemaData) : [];

  const syncFormToJson = useCallback(() => {
    if (resolvedFields.length > 0) {
      const hasValues = Object.keys(schemaFormValues).length > 0;
      if (hasValues) {
        const payload = formValuesToPayload(schemaFormValues, resolvedFields);
        setAdvancedPayload(JSON.stringify(payload, null, 2));
      } else if (schemaData != null) {
        setAdvancedPayload(generateJsonStub(schemaData));
      }
    }
  }, [schemaFormValues, resolvedFields, schemaData]);

  const syncJsonToForm = useCallback(() => {
    try {
      const parsed = JSON.parse(advancedPayload) as Record<string, unknown>;
      setSchemaFormValues(parsed);
    } catch {
      // Keep current form values if JSON is invalid
    }
  }, [advancedPayload]);

  const mutation = useMutation({
    mutationFn: (params: { action: string; payload: Record<string, unknown> }) => {
      const version = is16 ? 'v16' : 'v21';
      return api.post<CommandResponse>(`/v1/ocpp/commands/${version}/${params.action}`, {
        stationId,
        ...params.payload,
      });
    },
    onSuccess: (data) => {
      setResult(data);
    },
    onError: (err: unknown) => {
      const body = (err as { body?: CommandResponse }).body;
      if (body?.status != null) {
        setResult(body);
      } else {
        setResult({
          status: 'error',
          stationId,
          action: activeAction ?? advancedAction,
          error: err instanceof Error ? err.message : 'Request failed',
        });
      }
    },
  });

  const advancedMutation = useMutation({
    mutationFn: (params: { action: string; payload: Record<string, unknown> }) => {
      const version = is16 ? 'v16' : 'v21';
      return api.post<CommandResponse>(`/v1/ocpp/commands/${version}/${params.action}`, {
        stationId,
        ...params.payload,
      });
    },
    onSuccess: (data) => {
      setAdvancedResult(data);
    },
    onError: (err: unknown) => {
      const body = (err as { body?: CommandResponse }).body;
      if (body?.status != null) {
        setAdvancedResult(body);
      } else {
        setAdvancedResult({
          status: 'error',
          stationId,
          action: advancedAction,
          error: err instanceof Error ? err.message : 'Request failed',
        });
      }
    },
  });

  function openQuickAction(action: QuickAction | QuickAction16): void {
    setActiveAction(action);
    setForm(is16 ? INITIAL_FORM_16 : INITIAL_FORM);
    setResult(null);
    mutation.reset();
  }

  function closeQuickAction(): void {
    setActiveAction(null);
    setResult(null);
    mutation.reset();
  }

  function handleQuickSubmit(): void {
    if (activeAction == null) return;
    setResult(null);
    if (is16) {
      mutation.mutate({
        action: activeAction,
        payload: buildPayload16(activeAction as QuickAction16, form),
      });
    } else {
      mutation.mutate({
        action: activeAction,
        payload: buildPayload(activeAction as QuickAction, form),
      });
    }
  }

  function handleAdvancedSubmit(): void {
    let parsed: Record<string, unknown>;
    if (rawMode || schemaError) {
      try {
        parsed = JSON.parse(advancedPayload) as Record<string, unknown>;
      } catch {
        setAdvancedResult({
          status: 'error',
          stationId,
          action: advancedAction,
          error: t('commands.invalidJson'),
        });
        return;
      }
    } else {
      parsed = formValuesToPayload(schemaFormValues, resolvedFields);
    }
    setAdvancedResult(null);
    advancedMutation.mutate({ action: advancedAction, payload: parsed });
  }

  const quickActions = is16 ? QUICK_ACTIONS_16 : QUICK_ACTIONS;
  const csmsActions = is16 ? CSMS_ACTIONS_16 : CSMS_ACTIONS;

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t('commands.title')}</CardTitle>
      </CardHeader>
      <CardContent className="space-y-6">
        <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-5 gap-2">
          {quickActions.map(({ action, labelKey }) => (
            <Button
              key={action}
              variant="outline"
              size="sm"
              onClick={() => {
                openQuickAction(action);
              }}
            >
              {t(labelKey)}
            </Button>
          ))}
        </div>

        <div className="space-y-3">
          <h3 className="text-sm font-medium">{t('commands.advancedCommand')}</h3>
          <div className="space-y-2">
            <Label htmlFor="advanced-action-select">{t('commands.action')}</Label>
            <Select
              id="advanced-action-select"
              value={advancedAction}
              onChange={(e) => {
                setAdvancedAction(e.target.value);
                setSchemaFormValues({});
                setAdvancedPayload('{}');
                setRawMode(false);
                setAdvancedResult(null);
              }}
              className="h-9"
            >
              <option value="">--</option>
              {csmsActions.map((a) => (
                <option key={a} value={a}>
                  {a}
                </option>
              ))}
            </Select>
          </div>
          {advancedAction !== '' && (
            <>
              <div className="space-y-2">
                <div className="flex items-center justify-between">
                  <Label>{t('commands.payloadJson')}</Label>
                  {!schemaLoading && !schemaError && (
                    <button
                      type="button"
                      className="text-xs text-muted-foreground hover:text-foreground underline"
                      onClick={() => {
                        if (rawMode) {
                          syncJsonToForm();
                        } else {
                          syncFormToJson();
                        }
                        setRawMode((prev) => !prev);
                      }}
                    >
                      {rawMode ? t('commands.switchToForm') : t('commands.switchToJson')}
                    </button>
                  )}
                </div>
                {schemaLoading ? (
                  <div className="flex items-center gap-2 text-sm text-muted-foreground py-2">
                    <Loader2 className="h-4 w-4 animate-spin" />
                    {t('common.loading')}
                  </div>
                ) : rawMode || schemaError ? (
                  <textarea
                    value={advancedPayload}
                    onChange={(e) => {
                      setAdvancedPayload(e.target.value);
                    }}
                    className="flex min-h-[80px] w-full rounded-md border border-input bg-background px-3 py-2 text-sm font-mono"
                    rows={4}
                  />
                ) : (
                  <SchemaForm
                    fields={resolvedFields}
                    values={schemaFormValues}
                    onChange={setSchemaFormValues}
                  />
                )}
              </div>
              <Button
                size="sm"
                onClick={() => {
                  setAdvancedOpen(true);
                  setAdvancedResult(null);
                  advancedMutation.reset();
                  handleAdvancedSubmit();
                }}
                disabled={advancedMutation.isPending}
              >
                {advancedMutation.isPending && <Loader2 className="h-4 w-4 animate-spin" />}
                {t('common.send')}
              </Button>
            </>
          )}
        </div>

        <Dialog
          open={activeAction != null}
          onOpenChange={(open) => {
            if (!open) closeQuickAction();
          }}
        >
          <DialogContent>
            <DialogHeader>
              <DialogTitle>{activeAction}</DialogTitle>
            </DialogHeader>
            <div>
              {activeAction != null &&
                (is16 ? (
                  <QuickActionForm16
                    action={activeAction as QuickAction16}
                    form={form}
                    onChange={(patch) => {
                      setForm((prev) => ({ ...prev, ...patch }));
                    }}
                  />
                ) : (
                  <QuickActionForm
                    action={activeAction as QuickAction}
                    form={form}
                    onChange={(patch) => {
                      setForm((prev) => ({ ...prev, ...patch }));
                    }}
                  />
                ))}
              {result != null && (
                <div className="mt-4">
                  <Label>{t('commands.response')}</Label>
                  <pre className="mt-1 rounded-md bg-muted p-3 text-xs overflow-auto max-h-60">
                    {JSON.stringify(result, null, 2)}
                  </pre>
                </div>
              )}
            </div>
            <DialogFooter>
              <Button variant="outline" onClick={closeQuickAction}>
                {t('common.close')}
              </Button>
              <Button onClick={handleQuickSubmit} disabled={mutation.isPending}>
                {mutation.isPending && <Loader2 className="h-4 w-4 animate-spin" />}
                {t('common.send')}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>

        <Dialog open={advancedOpen} onOpenChange={setAdvancedOpen}>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>{advancedAction}</DialogTitle>
            </DialogHeader>
            <div>
              {advancedMutation.isPending && (
                <div className="flex items-center gap-2 text-sm text-muted-foreground">
                  <Loader2 className="h-4 w-4 animate-spin" />
                  {t('commands.waitingForResponse')}
                </div>
              )}
              {advancedResult != null && (
                <div>
                  <Label>{t('commands.response')}</Label>
                  <pre className="mt-1 rounded-md bg-muted p-3 text-xs overflow-auto max-h-60">
                    {JSON.stringify(advancedResult, null, 2)}
                  </pre>
                </div>
              )}
            </div>
            <DialogFooter>
              <Button
                variant="outline"
                onClick={() => {
                  setAdvancedOpen(false);
                }}
              >
                {t('common.close')}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </CardContent>
    </Card>
  );
}
