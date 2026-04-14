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
}

export function SchemaForm({ fields, values, onChange }: SchemaFormProps): React.JSX.Element {
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
  onChange,
}: {
  field: ResolvedField;
  value: unknown;
  onChange: (val: unknown) => void;
}): React.JSX.Element {
  switch (field.kind) {
    case 'enum':
      return (
        <FieldWrapper field={field}>
          <Select
            id={`schema-field-${field.name}`}
            value={asString(value)}
            onChange={(e) => {
              onChange(e.target.value);
            }}
            className="h-9"
          >
            {!field.required && <option value="">--</option>}
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
        <FieldWrapper field={field}>
          <Input
            type="datetime-local"
            value={asString(value)}
            onChange={(e) => {
              onChange(e.target.value);
            }}
          />
        </FieldWrapper>
      );

    case 'integer':
      return (
        <FieldWrapper field={field}>
          <Input
            type="number"
            step="1"
            value={asString(value)}
            onChange={(e) => {
              onChange(e.target.value);
            }}
          />
        </FieldWrapper>
      );

    case 'number':
      return (
        <FieldWrapper field={field}>
          <Input
            type="number"
            step="any"
            value={asString(value)}
            onChange={(e) => {
              onChange(e.target.value);
            }}
          />
        </FieldWrapper>
      );

    case 'boolean':
      return (
        <FieldWrapper field={field}>
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
      return <ObjectFieldRenderer field={field} value={asRecord(value)} onChange={onChange} />;

    case 'array':
      return <ArrayFieldRenderer field={field} value={asArray(value)} onChange={onChange} />;

    default:
      return (
        <FieldWrapper field={field}>
          <Input
            value={asString(value)}
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
  children,
}: {
  field: ResolvedField;
  children: React.ReactNode;
}): React.JSX.Element {
  return (
    <div className="space-y-1">
      <Label htmlFor={`schema-field-${field.name}`}>
        {field.name}
        {field.required && <span className="text-red-500 ml-0.5">*</span>}
      </Label>
      {children}
      {field.description != null && (
        <p className="text-xs text-muted-foreground">{field.description}</p>
      )}
    </div>
  );
}

function ObjectFieldRenderer({
  field,
  value,
  onChange,
}: {
  field: ResolvedField;
  value: Record<string, unknown>;
  onChange: (val: unknown) => void;
}): React.JSX.Element {
  const [expanded, setExpanded] = useState(field.required);

  if (field.objectFields == null || field.objectFields.length === 0) {
    return (
      <FieldWrapper field={field}>
        <p className="text-sm text-muted-foreground">--</p>
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
        {expanded ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
        {field.name}
        {field.required && <span className="text-red-500 ml-0.5">*</span>}
      </button>
      {field.description != null && (
        <p className="text-xs text-muted-foreground">{field.description}</p>
      )}
      {expanded && (
        <div className="space-y-4 pl-4 border-l border-input">
          {field.objectFields.map((subField) => (
            <FieldRenderer
              key={subField.name}
              field={subField}
              value={value[subField.name]}
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
  onChange,
}: {
  field: ResolvedField;
  value: unknown[];
  onChange: (val: unknown) => void;
}): React.JSX.Element {
  const { t } = useTranslation();

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
        {field.required && <span className="text-red-500 ml-0.5">*</span>}
      </Label>
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
