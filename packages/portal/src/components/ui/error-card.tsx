// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { AlertCircle } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Card, CardContent } from '@/components/ui/card';

interface ErrorCardProps {
  message: string;
  className?: string;
}

export function ErrorCard({ message, className }: ErrorCardProps) {
  return (
    <Card className={cn('w-full max-w-sm text-center', className)}>
      <CardContent className="flex flex-col items-center gap-2 p-6">
        <AlertCircle className="h-6 w-6 text-destructive" />
        <p className="text-sm text-destructive">{message}</p>
      </CardContent>
    </Card>
  );
}
