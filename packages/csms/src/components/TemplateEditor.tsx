// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { useRef, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { WysiwygEditor, type WysiwygEditorHandle } from '@/components/wysiwyg-editor';
import type { TemplateVariable } from '@/lib/template-variables';

interface TemplateEditorProps {
  channel: 'email' | 'sms' | 'webhook';
  subject: string;
  onSubjectChange: (subject: string) => void;
  bodyText: string;
  onBodyTextChange: (bodyText: string) => void;
  bodyHtml: string;
  onBodyHtmlChange: (bodyHtml: string) => void;
  variables: TemplateVariable[];
}

export function TemplateEditor({
  channel,
  subject,
  onSubjectChange,
  bodyText,
  onBodyTextChange,
  bodyHtml,
  onBodyHtmlChange,
  variables,
}: TemplateEditorProps): React.JSX.Element {
  const { t } = useTranslation();
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const wysiwygRef = useRef<WysiwygEditorHandle>(null);

  const isEmail = channel === 'email';
  const isSms = channel === 'sms';

  const handleVariableClick = useCallback(
    (variableName: string) => {
      const token = `{{${variableName}}}`;
      if (isEmail) {
        wysiwygRef.current?.insertText(token);
      } else if (textareaRef.current != null) {
        const textarea = textareaRef.current;
        const start = textarea.selectionStart;
        const end = textarea.selectionEnd;
        const before = bodyText.slice(0, start);
        const after = bodyText.slice(end);
        onBodyTextChange(before + token + after);
        requestAnimationFrame(() => {
          textarea.selectionStart = start + token.length;
          textarea.selectionEnd = start + token.length;
          textarea.focus();
        });
      }
    },
    [isEmail, bodyText, onBodyTextChange],
  );

  const handleTextareaDrop = useCallback(
    (e: React.DragEvent<HTMLTextAreaElement>) => {
      e.preventDefault();
      const text = e.dataTransfer.getData('text/plain');
      if (text === '' || textareaRef.current == null) return;

      const textarea = textareaRef.current;
      const start = textarea.selectionStart;
      const end = textarea.selectionEnd;
      const before = bodyText.slice(0, start);
      const after = bodyText.slice(end);
      const newValue = before + text + after;
      onBodyTextChange(newValue);

      requestAnimationFrame(() => {
        textarea.selectionStart = start + text.length;
        textarea.selectionEnd = start + text.length;
        textarea.focus();
      });
    },
    [bodyText, onBodyTextChange],
  );

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
  }, []);

  return (
    <div className="space-y-4">
      {isEmail && (
        <div className="space-y-2">
          <Label htmlFor="tpl-subject">{t('notifications.templateSubject')}</Label>
          <Input
            id="tpl-subject"
            value={subject}
            onChange={(e) => {
              onSubjectChange(e.target.value);
            }}
            onDragOver={(e) => {
              e.preventDefault();
              e.dataTransfer.dropEffect = 'copy';
            }}
            onDrop={(e) => {
              e.preventDefault();
              const text = e.dataTransfer.getData('text/plain');
              if (text !== '') {
                const input = e.target as HTMLInputElement;
                const start = input.selectionStart ?? subject.length;
                onSubjectChange(subject.slice(0, start) + text + subject.slice(start));
              }
            }}
            placeholder={t('notifications.templateSubject')}
          />
        </div>
      )}

      <div className="space-y-2">
        <Label htmlFor="tpl-body">{t('notifications.templateBody')}</Label>
        {isEmail ? (
          <WysiwygEditor ref={wysiwygRef} value={bodyHtml} onChange={onBodyHtmlChange} />
        ) : (
          <div>
            <textarea
              id="tpl-body"
              ref={textareaRef}
              value={bodyText}
              onChange={(e) => {
                onBodyTextChange(e.target.value);
              }}
              onDragOver={handleDragOver}
              onDrop={handleTextareaDrop}
              className="flex min-h-[200px] w-full rounded-md border border-input bg-transparent px-3 py-2 text-sm shadow-sm font-mono"
            />
            {isSms && (
              <p className="mt-2 text-xs text-muted-foreground">
                {bodyText.length}/160 {t('notifications.characters')}
              </p>
            )}
          </div>
        )}
      </div>

      {variables.length > 0 && (
        <div className="space-y-2">
          <Label className="text-xs text-muted-foreground">{t('notifications.variableHint')}</Label>
          <div className="flex flex-wrap gap-2">
            {variables.map((v) => (
              <button
                type="button"
                key={v.name}
                draggable
                onDragStart={(e) => {
                  e.dataTransfer.setData('text/plain', `{{${v.name}}}`);
                  e.dataTransfer.effectAllowed = 'copy';
                }}
                onClick={() => {
                  handleVariableClick(v.name);
                }}
                className="cursor-pointer px-2 py-1 bg-muted rounded text-sm select-none hover:bg-muted/80 transition-colors"
                title={v.description}
              >
                {`{{${v.name}}}`}
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
