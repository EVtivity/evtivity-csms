// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { useState, useCallback, useEffect, useImperativeHandle, useRef, forwardRef } from 'react';
import { useEditor, EditorContent } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import Link from '@tiptap/extension-link';
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
    const [showSource, setShowSource] = useState(false);
    const [sourceValue, setSourceValue] = useState('');
    const sourceRef = useRef<HTMLTextAreaElement>(null);

    const editor = useEditor({
      extensions: [
        StarterKit,
        Link.configure({ openOnClick: false }),
        TextAlign.configure({ types: ['heading', 'paragraph'] }),
        Color,
        TextStyle,
        Placeholder.configure({ placeholder: placeholder ?? 'Start typing...' }),
        Table.extend({
          addAttributes() {
            return {
              ...this.parent?.(),
              style: {
                default: null,
                parseHTML: (el: HTMLElement) => el.getAttribute('style'),
                renderHTML: (attrs: Record<string, unknown>) =>
                  attrs.style != null ? { style: attrs.style } : {},
              },
            };
          },
        }).configure({ resizable: false }),
        TableRow.extend({
          addAttributes() {
            return {
              ...this.parent?.(),
              style: {
                default: null,
                parseHTML: (el: HTMLElement) => el.getAttribute('style'),
                renderHTML: (attrs: Record<string, unknown>) =>
                  attrs.style != null ? { style: attrs.style } : {},
              },
            };
          },
        }),
        TableCell.extend({
          addAttributes() {
            return {
              ...this.parent?.(),
              style: {
                default: null,
                parseHTML: (el: HTMLElement) => el.getAttribute('style'),
                renderHTML: (attrs: Record<string, unknown>) =>
                  attrs.style != null ? { style: attrs.style } : {},
              },
            };
          },
        }),
        TableHeader.extend({
          addAttributes() {
            return {
              ...this.parent?.(),
              style: {
                default: null,
                parseHTML: (el: HTMLElement) => el.getAttribute('style'),
                renderHTML: (attrs: Record<string, unknown>) =>
                  attrs.style != null ? { style: attrs.style } : {},
              },
            };
          },
        }),
      ],
      content: value,
      onUpdate: ({ editor: ed }) => {
        onChange(cleanCellParagraphs(ed.getHTML()));
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

    // Sync external value changes into the editor (e.g. after reset to default).
    useEffect(() => {
      if (editor.isDestroyed) return;
      const current = cleanCellParagraphs(editor.getHTML());
      if (current !== value) {
        editor.commands.setContent(value, { emitUpdate: false });
      }
    }, [editor, value]);

    // Native DOM listeners for drag-and-drop variable insertion.
    useEffect(() => {
      let dom: HTMLElement;
      try {
        dom = editor.view.dom;
      } catch {
        // Editor view not mounted yet (e.g. inside a hidden tab)
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
        editor.commands.setContent(sourceValue);
        onChange(sourceValue);
        setShowSource(false);
      } else {
        setSourceValue(formatHtml(cleanCellParagraphs(editor.getHTML())));
        setShowSource(true);
      }
    }, [showSource, sourceValue, editor, onChange]);

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
            title="Bold"
          >
            <Bold className="h-4 w-4" />
          </ToolbarButton>
          <ToolbarButton
            onClick={() => {
              editor.chain().focus().toggleItalic().run();
            }}
            active={editor.isActive('italic')}
            title="Italic"
          >
            <Italic className="h-4 w-4" />
          </ToolbarButton>
          <ToolbarButton
            onClick={() => {
              editor.chain().focus().toggleStrike().run();
            }}
            active={editor.isActive('strike')}
            title="Strikethrough"
          >
            <Strikethrough className="h-4 w-4" />
          </ToolbarButton>

          <div className="w-px bg-border mx-1" />

          <ToolbarButton
            onClick={() => {
              editor.chain().focus().toggleHeading({ level: 1 }).run();
            }}
            active={editor.isActive('heading', { level: 1 })}
            title="Heading 1"
          >
            <Heading1 className="h-4 w-4" />
          </ToolbarButton>
          <ToolbarButton
            onClick={() => {
              editor.chain().focus().toggleHeading({ level: 2 }).run();
            }}
            active={editor.isActive('heading', { level: 2 })}
            title="Heading 2"
          >
            <Heading2 className="h-4 w-4" />
          </ToolbarButton>
          <ToolbarButton
            onClick={() => {
              editor.chain().focus().toggleHeading({ level: 3 }).run();
            }}
            active={editor.isActive('heading', { level: 3 })}
            title="Heading 3"
          >
            <Heading3 className="h-4 w-4" />
          </ToolbarButton>

          <div className="w-px bg-border mx-1" />

          <ToolbarButton
            onClick={() => {
              editor.chain().focus().toggleBulletList().run();
            }}
            active={editor.isActive('bulletList')}
            title="Bullet list"
          >
            <List className="h-4 w-4" />
          </ToolbarButton>
          <ToolbarButton
            onClick={() => {
              editor.chain().focus().toggleOrderedList().run();
            }}
            active={editor.isActive('orderedList')}
            title="Ordered list"
          >
            <ListOrdered className="h-4 w-4" />
          </ToolbarButton>

          <div className="w-px bg-border mx-1" />

          <ToolbarButton
            onClick={() => {
              editor.chain().focus().setTextAlign('left').run();
            }}
            active={editor.isActive({ textAlign: 'left' })}
            title="Align left"
          >
            <AlignLeft className="h-4 w-4" />
          </ToolbarButton>
          <ToolbarButton
            onClick={() => {
              editor.chain().focus().setTextAlign('center').run();
            }}
            active={editor.isActive({ textAlign: 'center' })}
            title="Align center"
          >
            <AlignCenter className="h-4 w-4" />
          </ToolbarButton>
          <ToolbarButton
            onClick={() => {
              editor.chain().focus().setTextAlign('right').run();
            }}
            active={editor.isActive({ textAlign: 'right' })}
            title="Align right"
          >
            <AlignRight className="h-4 w-4" />
          </ToolbarButton>

          <div className="w-px bg-border mx-1" />

          <ToolbarButton onClick={addLink} active={editor.isActive('link')} title="Insert link">
            <LinkIcon className="h-4 w-4" />
          </ToolbarButton>

          <div className="w-px bg-border mx-1" />

          <input
            type="color"
            aria-label="Text color"
            className="w-8 h-8 rounded cursor-pointer border-0 p-0.5"
            onChange={(e) => {
              editor.chain().focus().setColor(e.target.value).run();
            }}
            title="Text color"
          />

          <div className="w-px bg-border mx-1" />

          <ToolbarButton
            onClick={() => {
              editor.chain().focus().undo().run();
            }}
            active={false}
            title="Undo"
          >
            <Undo className="h-4 w-4" />
          </ToolbarButton>
          <ToolbarButton
            onClick={() => {
              editor.chain().focus().redo().run();
            }}
            active={false}
            title="Redo"
          >
            <Redo className="h-4 w-4" />
          </ToolbarButton>

          <div className="flex-1" />

          <ToolbarButton onClick={toggleSource} active={showSource} title="HTML source">
            <Code className="h-4 w-4" />
          </ToolbarButton>
        </div>

        {showSource ? (
          <textarea
            ref={sourceRef}
            className="w-full min-h-[200px] p-3 font-mono text-sm bg-background resize-y focus:outline-none"
            value={sourceValue}
            onChange={(e) => {
              setSourceValue(e.target.value);
              onChange(e.target.value);
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
    >
      {children}
    </Button>
  );
}
