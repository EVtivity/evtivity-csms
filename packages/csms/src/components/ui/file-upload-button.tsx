// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { useRef } from 'react';
import { Paperclip } from 'lucide-react';
import { Button, type ButtonProps } from '@/components/ui/button';
import { cn } from '@/lib/utils';

interface FileUploadButtonProps extends Omit<ButtonProps, 'onChange'> {
  onFiles: (files: File[]) => void;
  multiple?: boolean;
  accept?: string;
}

export function FileUploadButton({
  onFiles,
  multiple = false,
  accept,
  children,
  ...buttonProps
}: FileUploadButtonProps): React.JSX.Element {
  const inputRef = useRef<HTMLInputElement>(null);

  function handleChange(e: React.ChangeEvent<HTMLInputElement>): void {
    const { files } = e.target;
    if (files != null && files.length > 0) {
      onFiles(Array.from(files));
    }
    e.target.value = '';
  }

  return (
    <>
      <input
        ref={inputRef}
        type="file"
        multiple={multiple}
        accept={accept}
        className="hidden"
        onChange={handleChange}
      />
      <Button
        type="button"
        {...buttonProps}
        className={cn('gap-2', buttonProps.className)}
        onClick={(e) => {
          inputRef.current?.click();
          buttonProps.onClick?.(e);
        }}
      >
        <Paperclip className="h-4 w-4 shrink-0" />
        {children != null && <span>{children}</span>}
      </Button>
    </>
  );
}
