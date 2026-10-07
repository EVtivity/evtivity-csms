// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { useState, useCallback, useEffect, useImperativeHandle, useRef, forwardRef } from 'react';
import { useTranslation } from 'react-i18next';
import { useEditor, EditorContent } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import TextAlign from '@tiptap/extension-text-align';
import Color from '@tiptap/extension-color';
import { TextStyle } from '@tiptap/extension-text-style';
import Placeholder from '@tiptap/extension-placeholder';
import { Table } from '@tiptap/extension-table';
import { TableRow } from '@tiptap/extension-table-row';
import { TableCell } from '@tiptap/extension-table-cell';
import { TableHeader } from '@tiptap/extension-table-header';
import { Button } from '@/components/ui/button';
import {
  Bold,
  Italic,
  Strikethrough,
  List,
  ListOrdered,
  AlignLeft,
  AlignCenter,
  AlignRight,
  Link as LinkIcon,
  Heading1,
  Heading2,
  Heading3,
  Code,
  Undo,
  Redo,
} from 'lucide-react';

const BLOCK_TAGS = new Set([
  'table',
  'thead',
  'tbody',
  'tfoot',
  'tr',
  'td',
  'th',
  'div',
  'p',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'ul',
  'ol',
  'li',
  'blockquote',
]);

function formatHtml(html: string): string {
  const tokens: string[] = [];
  let buf = '';
  for (let i = 0; i < html.length; i++) {
    const ch = html.charAt(i);
    if (ch === '<') {
      if (buf.trim()) tokens.push(buf);
      buf = '<';
    } else if (ch === '>') {
      buf += '>';
      tokens.push(buf);
      buf = '';
    } else {
      buf += ch;
    }
  }
  if (buf.trim()) tokens.push(buf);

  let indent = 0;
  const tab = '  ';
  const lines: string[] = [];
  let inline = '';

  for (const token of tokens) {
    if (token.startsWith('<')) {
      const m = token.match(/^<\/?(\w+)/);
      const name = m?.[1] != null ? m[1].toLowerCase() : '';
      const closing = token.startsWith('</');

      if (BLOCK_TAGS.has(name)) {
        if (inline.trim()) {
          lines.push(tab.repeat(indent) + inline.trim());
          inline = '';
        }
        if (closing) {
          indent = Math.max(0, indent - 1);
        }
        lines.push(tab.repeat(indent) + token);
        if (!closing && !token.endsWith('/>')) {
          indent++;
        }
      } else {
        inline += token;
      }
    } else {
      inline += token;
    }
  }
  if (inline.trim()) {
    lines.push(tab.repeat(indent) + inline.trim());
  }
  return lines.join('\n');
}

/** Strip single-<p> wrappers ProseMirror inserts inside table cells. */
function cleanCellParagraphs(html: string): string {
  return html.replace(/<(td|th)([^>]*)><p>([\s\S]*?)<\/p><\/(td|th)>/gi, '<$1$2>$3</$4>');
}

// Tiptap strips inline `style` from table parts by default. We need them to
// survive a save/load cycle so operator-edited templates keep their colors,
// borders, and widths. The four table extensions all need the same attribute
// definition.
const styleAttribute = {
  style: {
    default: null,
    parseHTML: (el: HTMLElement): string | null => el.getAttribute('style'),
    renderHTML: (attrs: Record<string, unknown>): Record<string, unknown> =>
      attrs.style != null ? { style: attrs.style } : {},
  },
};

export interface WysiwygEditorHandle {
  insertText: (text: string) => void;
}

interface WysiwygEditorProps {
  value: string;
  onChange: (html: string) => void;
  placeholder?: string;
}

export const WysiwygEditor = forwardRef<WysiwygEditorHandle, WysiwygEditorProps>(
  function WysiwygEditor({ value, onChange, placeholder }, ref) {
    const { t } = useTranslation();
    const [showSource, setShowSource] = useState(false);
    const [sourceValue, setSourceValue] = useState('');
    const sourceRef = useRef<HTMLTextAreaElement>(null);
    // The value last loaded from outside and the editor's HTML for it. The editor normalizes
    // HTML, so when an edit (or an undo) brings the document back to that HTML, onChange
    // reports the loaded value: a parent comparing it with the saved template sees no change.
    const loadedRef = useRef<{ value: string; html: string } | null>(null);
    // The source text when the HTML source view opened, and the value at that moment.
    const sourceOpenRef = useRef<{ text: string; value: string } | null>(null);

    const editor = useEditor({
      extensions: [
        // StarterKit includes the Link extension; configure it here instead of adding it twice.
        StarterKit.configure({ link: { openOnClick: false } }),
        TextAlign.configure({ types: ['heading', 'paragraph'] }),
        Color,
        TextStyle,
        Placeholder.configure({ placeholder: placeholder ?? 'Start typing...' }),
        Table.extend({
          addAttributes() {
            return { ...this.parent?.(), ...styleAttribute };
          },
        }).configure({ resizable: false }),
        TableRow.extend({
          addAttributes() {
            return { ...this.parent?.(), ...styleAttribute };
          },
        }),
        TableCell.extend({
          addAttributes() {
            return { ...this.parent?.(), ...styleAttribute };
          },
        }),
        TableHeader.extend({
          addAttributes() {
            return { ...this.parent?.(), ...styleAttribute };
          },
        }),
      ],
      content: value,
      onUpdate: ({ editor: ed }) => {
        const html = cleanCellParagraphs(ed.getHTML());
        const loaded = loadedRef.current;
        onChange(loaded != null && html === loaded.html ? loaded.value : html);
      },
      editorProps: {
        handleDrop: (_view, event) => {
          const text = event.dataTransfer?.getData('text/plain');
          if (text != null && text.startsWith('{{')) {
            return true; // Block ProseMirror from handling template variable drops
          }
          return false;
        },
      },
    });

    useImperativeHandle(
      ref,
      () => ({
        insertText(text: string) {
          if (showSource) {
            const textarea = sourceRef.current;
            if (textarea != null) {
              const start = textarea.selectionStart;
              const end = textarea.selectionEnd;
              const before = sourceValue.slice(0, start);
              const after = sourceValue.slice(end);
              const updated = before + text + after;
              setSourceValue(updated);
              onChange(updated);
              requestAnimationFrame(() => {
                textarea.selectionStart = start + text.length;
                textarea.selectionEnd = start + text.length;
                textarea.focus();
              });
            }
          } else {
            editor.chain().focus().insertContent(text).run();
          }
        },
      }),
      [editor, showSource, sourceValue, onChange],
    );

    // Sync external value changes into the editor (e.g. after reset to default). A value this
    // editor emitted (an edit, or the loaded value reported back after an undo) is not reloaded.
    useEffect(() => {
      if (editor.isDestroyed) return;
      const current = cleanCellParagraphs(editor.getHTML());
      const loaded = loadedRef.current;
      if (current === value || (loaded?.value === value && loaded.html === current)) {
        loadedRef.current ??= { value, html: current };
        return;
      }
      editor.commands.setContent(value, { emitUpdate: false });
      loadedRef.current = { value, html: cleanCellParagraphs(editor.getHTML()) };
    }, [editor, value]);

    // Native DOM listeners for drag-and-drop variable insertion.
    useEffect(() => {
      let dom: HTMLElement;
      try {
        dom = editor.view.dom;
      } catch {
        // fail-open: the editor view is not mounted yet (e.g. inside a hidden tab)
        return;
      }

      const onDragOver = (e: DragEvent): void => {
        e.preventDefault();
        if (e.dataTransfer != null) e.dataTransfer.dropEffect = 'copy';
      };

      const onDrop = (e: DragEvent): void => {
        const text = e.dataTransfer?.getData('text/plain');
        if (text == null || text === '' || !text.startsWith('{{')) return;
        e.preventDefault();
        e.stopPropagation();
        const coords = editor.view.posAtCoords({ left: e.clientX, top: e.clientY });
        if (coords != null) {
          editor.chain().focus().insertContentAt(coords.pos, text).run();
        }
      };

      dom.addEventListener('dragover', onDragOver);
      dom.addEventListener('drop', onDrop);
      return () => {
        dom.removeEventListener('dragover', onDragOver);
        dom.removeEventListener('drop', onDrop);
      };
    }, [editor]);

    const toggleSource = useCallback(() => {
      if (showSource) {
        // Unedited source changes nothing: viewing the HTML is not an edit.
        if (sourceValue !== sourceOpenRef.current?.text) {
          editor.commands.setContent(sourceValue, { emitUpdate: false });
          onChange(sourceValue);
        }
        sourceOpenRef.current = null;
        setShowSource(false);
      } else {
        const text = formatHtml(cleanCellParagraphs(editor.getHTML()));
        sourceOpenRef.current = { text, value };
        setSourceValue(text);
        setShowSource(true);
      }
    }, [showSource, sourceValue, editor, onChange, value]);

    const addLink = useCallback(() => {
      const url = window.prompt('URL');
      if (url != null && url !== '') {
        editor.chain().focus().setLink({ href: url }).run();
      }
    }, [editor]);

    return (
      <div className="border rounded-md">
        <div className="flex flex-wrap gap-1 p-2 border-b bg-muted/30">
          <ToolbarButton
            onClick={() => {
              editor.chain().focus().toggleBold().run();
            }}
            active={editor.isActive('bold')}
            title={t('editor.bold')}
          >
            <Bold className="h-4 w-4" />
          </ToolbarButton>
          <ToolbarButton
            onClick={() => {
              editor.chain().focus().toggleItalic().run();
            }}
            active={editor.isActive('italic')}
            title={t('editor.italic')}
          >
            <Italic className="h-4 w-4" />
          </ToolbarButton>
          <ToolbarButton
            onClick={() => {
              editor.chain().focus().toggleStrike().run();
            }}
            active={editor.isActive('strike')}
            title={t('editor.strikethrough')}
          >
            <Strikethrough className="h-4 w-4" />
          </ToolbarButton>

          <div className="w-px bg-border mx-1" />

          <ToolbarButton
            onClick={() => {
              editor.chain().focus().toggleHeading({ level: 1 }).run();
            }}
            active={editor.isActive('heading', { level: 1 })}
            title={t('editor.heading1')}
          >
            <Heading1 className="h-4 w-4" />
          </ToolbarButton>
          <ToolbarButton
            onClick={() => {
              editor.chain().focus().toggleHeading({ level: 2 }).run();
            }}
            active={editor.isActive('heading', { level: 2 })}
            title={t('editor.heading2')}
          >
            <Heading2 className="h-4 w-4" />
          </ToolbarButton>
          <ToolbarButton
            onClick={() => {
              editor.chain().focus().toggleHeading({ level: 3 }).run();
            }}
            active={editor.isActive('heading', { level: 3 })}
            title={t('editor.heading3')}
          >
            <Heading3 className="h-4 w-4" />
          </ToolbarButton>

          <div className="w-px bg-border mx-1" />

          <ToolbarButton
            onClick={() => {
              editor.chain().focus().toggleBulletList().run();
            }}
            active={editor.isActive('bulletList')}
            title={t('editor.bulletList')}
          >
            <List className="h-4 w-4" />
          </ToolbarButton>
          <ToolbarButton
            onClick={() => {
              editor.chain().focus().toggleOrderedList().run();
            }}
            active={editor.isActive('orderedList')}
            title={t('editor.orderedList')}
          >
            <ListOrdered className="h-4 w-4" />
          </ToolbarButton>

          <div className="w-px bg-border mx-1" />

          <ToolbarButton
            onClick={() => {
              editor.chain().focus().setTextAlign('left').run();
            }}
            active={editor.isActive({ textAlign: 'left' })}
            title={t('editor.alignLeft')}
          >
            <AlignLeft className="h-4 w-4" />
          </ToolbarButton>
          <ToolbarButton
            onClick={() => {
              editor.chain().focus().setTextAlign('center').run();
            }}
            active={editor.isActive({ textAlign: 'center' })}
            title={t('editor.alignCenter')}
          >
            <AlignCenter className="h-4 w-4" />
          </ToolbarButton>
          <ToolbarButton
            onClick={() => {
              editor.chain().focus().setTextAlign('right').run();
            }}
            active={editor.isActive({ textAlign: 'right' })}
            title={t('editor.alignRight')}
          >
            <AlignRight className="h-4 w-4" />
          </ToolbarButton>

          <div className="w-px bg-border mx-1" />

          <ToolbarButton
            onClick={addLink}
            active={editor.isActive('link')}
            title={t('editor.insertLink')}
          >
            <LinkIcon className="h-4 w-4" />
          </ToolbarButton>

          <div className="w-px bg-border mx-1" />

          <input
            type="color"
            aria-label={t('editor.textColor')}
            className="w-8 h-8 rounded cursor-pointer border-0 p-0.5"
            onChange={(e) => {
              editor.chain().focus().setColor(e.target.value).run();
            }}
            title={t('editor.textColor')}
          />

          <div className="w-px bg-border mx-1" />

          <ToolbarButton
            onClick={() => {
              editor.chain().focus().undo().run();
            }}
            active={false}
            title={t('editor.undo')}
          >
            <Undo className="h-4 w-4" />
          </ToolbarButton>
          <ToolbarButton
            onClick={() => {
              editor.chain().focus().redo().run();
            }}
            active={false}
            title={t('editor.redo')}
          >
            <Redo className="h-4 w-4" />
          </ToolbarButton>

          <div className="flex-1" />

          <ToolbarButton onClick={toggleSource} active={showSource} title={t('editor.htmlSource')}>
            <Code className="h-4 w-4" />
          </ToolbarButton>
        </div>

        {showSource ? (
          <textarea
            ref={sourceRef}
            className="w-full min-h-[200px] p-3 font-mono text-sm bg-background resize-y focus:outline-hidden"
            value={sourceValue}
            onChange={(e) => {
              const text = e.target.value;
              setSourceValue(text);
              const opened = sourceOpenRef.current;
              onChange(opened != null && text === opened.text ? opened.value : text);
            }}
          />
        ) : (
          <EditorContent editor={editor} className="wysiwyg-email-editor" />
        )}
      </div>
    );
  },
);

function ToolbarButton({
  children,
  onClick,
  active,
  title,
}: {
  children: React.ReactNode;
  onClick: () => void;
  active: boolean;
  title: string;
}): React.JSX.Element {
  return (
    <Button
      type="button"
      variant="ghost"
      size="sm"
      className={`h-8 w-8 p-0 ${active ? 'bg-accent text-accent-foreground' : ''}`}
      onClick={onClick}
      title={title}
      aria-label={title}
    >
      {children}
    </Button>
  );
}
