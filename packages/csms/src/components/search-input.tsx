// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { useState, useEffect, forwardRef } from 'react';
import { Search, X } from 'lucide-react';
import { Input } from '@/components/ui/input';
import { cn } from '@/lib/utils';

interface SearchInputProps {
  value: string;
  onDebouncedChange: (value: string) => void;
  placeholder?: string;
  size?: 'default' | 'sm';
  className?: string;
}

export const SearchInput = forwardRef<HTMLInputElement, SearchInputProps>(function SearchInput(
  { value, onDebouncedChange, placeholder = 'Search...', size = 'default', className },
  ref,
) {
  const [input, setInput] = useState(value);

  useEffect(() => {
    setInput(value);
  }, [value]);

  useEffect(() => {
    const timer = setTimeout(() => {
      if (input !== value) {
        onDebouncedChange(input);
      }
    }, 300);
    return () => {
      clearTimeout(timer);
    };
  }, [input, value, onDebouncedChange]);

  function handleClear(): void {
    setInput('');
    onDebouncedChange('');
  }

  return (
    <div className={cn('relative', className ?? 'w-full sm:max-w-sm')}>
      <Search className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
      <Input
        ref={ref}
        value={input}
        onChange={(e) => {
          setInput(e.target.value);
        }}
        placeholder={placeholder}
        className={cn('pl-9 pr-9', size === 'sm' && 'h-8')}
      />
      {input !== '' && (
        <button
          type="button"
          onClick={handleClear}
          className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
        >
          <X className="h-4 w-4" />
        </button>
      )}
    </div>
  );
});
