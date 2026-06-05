// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ChevronDown, ChevronRight, Plus, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select } from '@/components/ui/select';
import type { ResolvedField } from '@/lib/ocpp-schema';

interface SchemaFormProps {
  fields: ResolvedField[];
  values: Record<string, unknown>;
  onChange: (values: Record<string, unknown>) => void;
  errors?: Record<string, string>;
}

export function SchemaForm({
  fields,
  values,
  onChange,
  errors = {},
}: SchemaFormProps): React.JSX.Element {
  const { t } = useTranslation();

  if (fields.length === 0) {
    return <p className="text-sm text-muted-foreground">{t('commands.noParametersRequired')}</p>;
  }

  return (
    <div className="space-y-4">
      {fields.map((field) => (
        <FieldRenderer
          key={field.name}
          field={field}
          value={values[field.name]}
          path={field.name}
          errors={errors}
          onChange={(val) => {
            onChange({ ...values, [field.name]: val });
          }}
        />
      ))}
    </div>
  );
}

function asString(value: unknown): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'number') return String(value);
  return '';
}

function asRecord(value: unknown): Record<string, unknown> {
  if (typeof value === 'object' && value != null && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return {};
}

function asArray(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  return [];
}

function FieldRenderer({
  field,
  value,
  path,
  errors,
  onChange,
}: {
  field: ResolvedField;
  value: unknown;
  path: string;
  errors: Record<string, string>;
  onChange: (val: unknown) => void;
}): React.JSX.Element {
  const { t } = useTranslation();
  const error = errors[path];
  const errorClass = error != null ? 'border-destructive' : '';
  switch (field.kind) {
    case 'enum':
      return (
        <FieldWrapper field={field} error={error}>
          <Select
            id={`schema-field-${field.name}`}
            value={asString(value)}
            onChange={(e) => {
              onChange(e.target.value);
            }}
            className={`h-9 ${errorClass}`}
          >
            <option value="">{t('common.select')}</option>
            {field.enumValues?.map((v) => (
              <option key={v} value={v}>
                {v}
              </option>
            ))}
          </Select>
        </FieldWrapper>
      );

    case 'datetime':
      return (
        <FieldWrapper field={field} error={error}>
          <Input
            type="datetime-local"
            value={asString(value)}
            className={errorClass}
            onChange={(e) => {
              onChange(e.target.value);
            }}
          />
        </FieldWrapper>
      );

    case 'integer':
      return (
        <FieldWrapper field={field} error={error}>
          <Input
            type="number"
            step="1"
            value={asString(value)}
            className={errorClass}
            onChange={(e) => {
              onChange(e.target.value);
            }}
          />
        </FieldWrapper>
      );

    case 'number':
      return (
        <FieldWrapper field={field} error={error}>
          <Input
            type="number"
            step="any"
            value={asString(value)}
            className={errorClass}
            onChange={(e) => {
              onChange(e.target.value);
            }}
          />
        </FieldWrapper>
      );

    case 'boolean':
      return (
        <FieldWrapper field={field} error={error}>
          <label className="flex items-center gap-2">
            <input
              type="checkbox"
              checked={Boolean(value)}
              onChange={(e) => {
                onChange(e.target.checked);
              }}
              className="h-4 w-4 rounded border-input"
            />
            <span className="text-sm">{field.name}</span>
          </label>
        </FieldWrapper>
      );

    case 'object':
      return (
        <ObjectFieldRenderer
          field={field}
          value={asRecord(value)}
          path={path}
          errors={errors}
          onChange={onChange}
        />
      );

    case 'array':
      return (
        <ArrayFieldRenderer
          field={field}
          value={asArray(value)}
          path={path}
          errors={errors}
          onChange={onChange}
        />
      );

    default:
      return (
        <FieldWrapper field={field} error={error}>
          <Input
            value={asString(value)}
            className={errorClass}
            onChange={(e) => {
              onChange(e.target.value);
            }}
          />
        </FieldWrapper>
      );
  }
}

function FieldWrapper({
  field,
  error,
  children,
}: {
  field: ResolvedField;
  error?: string | undefined;
  children: React.ReactNode;
}): React.JSX.Element {
  return (
    <div className="space-y-1">
      <Label htmlFor={`schema-field-${field.name}`}>
        {field.name}
        {field.required && <span className="text-destructive ml-0.5">*</span>}
      </Label>
      {children}
      {error != null && <p className="text-xs text-destructive">{error}</p>}
      {field.description != null && (
        <p className="text-xs text-muted-foreground">{field.description}</p>
      )}
    </div>
  );
}

function hasNestedError(errors: Record<string, string>, path: string): boolean {
  const prefix = `${path}.`;
  return Object.keys(errors).some((key) => key === path || key.startsWith(prefix));
}

function ObjectFieldRenderer({
  field,
  value,
  path,
  errors,
  onChange,
}: {
  field: ResolvedField;
  value: Record<string, unknown>;
  path: string;
  errors: Record<string, string>;
  onChange: (val: unknown) => void;
}): React.JSX.Element {
  const [expanded, setExpanded] = useState(field.required);
  const error = errors[path];
  const forceExpanded = hasNestedError(errors, path);

  if (field.objectFields == null || field.objectFields.length === 0) {
    return (
      <FieldWrapper field={field} error={error}>
        <p className="text-sm text-muted-foreground">n/a</p>
      </FieldWrapper>
    );
  }

  return (
    <fieldset className="border border-input rounded-md p-3 space-y-3">
      <button
        type="button"
        className="flex items-center gap-1 text-sm font-medium w-full text-left"
        onClick={() => {
          setExpanded((prev) => !prev);
        }}
      >
        {expanded || forceExpanded ? (
          <ChevronDown className="h-4 w-4" />
        ) : (
          <ChevronRight className="h-4 w-4" />
        )}
        {field.name}
        {field.required && <span className="text-destructive ml-0.5">*</span>}
      </button>
      {error != null && <p className="text-xs text-destructive">{error}</p>}
      {field.description != null && (
        <p className="text-xs text-muted-foreground">{field.description}</p>
      )}
      {(expanded || forceExpanded) && (
        <div className="space-y-4 pl-4 border-l border-input">
          {field.objectFields.map((subField) => (
            <FieldRenderer
              key={subField.name}
              field={subField}
              value={value[subField.name]}
              path={`${path}.${subField.name}`}
              errors={errors}
              onChange={(val) => {
                onChange({ ...value, [subField.name]: val });
              }}
            />
          ))}
        </div>
      )}
    </fieldset>
  );
}

function ArrayFieldRenderer({
  field,
  value,
  path,
  errors,
  onChange,
}: {
  field: ResolvedField;
  value: unknown[];
  path: string;
  errors: Record<string, string>;
  onChange: (val: unknown) => void;
}): React.JSX.Element {
  const { t } = useTranslation();
  const error = errors[path];

  function addItem(): void {
    onChange([...value, {}]);
  }

  function removeItem(index: number): void {
    onChange(value.filter((_, i) => i !== index));
  }

  function updateItem(index: number, updated: unknown): void {
    const next = [...value];
    next[index] = updated;
    onChange(next);
  }

  return (
    <fieldset className="border border-input rounded-md p-3 space-y-3">
      <Label htmlFor={`schema-field-${field.name}`}>
        {field.name}
        {field.required && <span className="text-destructive ml-0.5">*</span>}
      </Label>
      {error != null && <p className="text-xs text-destructive">{error}</p>}
      {field.description != null && (
        <p className="text-xs text-muted-foreground">{field.description}</p>
      )}
      {value.map((item, index) => (
        <div key={index} className="space-y-3 pl-4 border-l border-input relative">
          <div className="flex items-center justify-between">
            <span className="text-xs font-medium text-muted-foreground">#{index + 1}</span>
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="h-6 px-2"
              onClick={() => {
                removeItem(index);
              }}
            >
              <Trash2 className="h-3 w-3" />
              {t('commands.removeItem')}
            </Button>
          </div>
          {field.arrayItemFields != null && field.arrayItemFields.length > 0 ? (
            field.arrayItemFields.map((subField) => (
              <FieldRenderer
                key={subField.name}
                field={subField}
                value={asRecord(item)[subField.name]}
                path={`${path}.${String(index)}.${subField.name}`}
                errors={errors}
                onChange={(val) => {
                  updateItem(index, {
                    ...asRecord(item),
                    [subField.name]: val,
                  });
                }}
              />
            ))
          ) : (
            <Input
              value={asString(item)}
              onChange={(e) => {
                updateItem(index, e.target.value);
              }}
            />
          )}
        </div>
      ))}
      <Button type="button" variant="outline" size="sm" onClick={addItem}>
        <Plus className="h-3 w-3" />
        {t('commands.addItem')}
      </Button>
    </fieldset>
  );
}
