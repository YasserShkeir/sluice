// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Input — the shadcn primitive on Sluice's palette.
 *
 * Monospace by default: every input in this app takes a hostname, a filter
 * expression or an id, and proportional type makes those harder to scan and
 * harder to compare against the monospace rows they filter.
 */
import type { ComponentProps } from 'react';
import { cn } from './cn.js';

export function Input({ className, ...props }: ComponentProps<'input'>) {
  return (
    <input
      className={cn(
        'h-7 w-full rounded border border-border-2 bg-bg px-2 font-mono text-[12.5px] text-fg',
        'placeholder:text-fg-mute outline-none transition-colors',
        'focus-visible:border-accent focus-visible:ring-1 focus-visible:ring-accent/50',
        'disabled:cursor-not-allowed disabled:opacity-50',
        className,
      )}
      {...props}
    />
  );
}
