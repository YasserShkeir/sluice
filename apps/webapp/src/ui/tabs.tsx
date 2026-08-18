// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Lightweight tabs — no Radix dependency.
 *
 * The inspector and a few other panes need a row of mutually exclusive
 * selectors. A full Tabs primitive with context is overkill when every caller
 * already owns its selected id in local state; this is just the chrome.
 */
import type { ComponentProps, ReactNode } from 'react';
import { cn } from './cn.js';

export function TabList({ className, ...props }: ComponentProps<'div'>) {
  return (
    <div
      role="tablist"
      className={cn('flex shrink-0 gap-0.5 border-b border-border px-2 pt-1', className)}
      {...props}
    />
  );
}

export function Tab({
  selected,
  className,
  ...props
}: ComponentProps<'button'> & { selected?: boolean }) {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={selected ? true : false}
      className={cn(
        'rounded-t px-2.5 py-1 text-[12px] transition-colors',
        'focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent',
        selected ? 'bg-bg-3 text-fg' : 'text-fg-dim hover:text-fg',
        className,
      )}
      {...props}
    />
  );
}

export function TabPanel({
  className,
  children,
  ...props
}: ComponentProps<'div'> & { children?: ReactNode }) {
  return (
    <div role="tabpanel" className={cn('flex min-h-0 flex-1 flex-col', className)} {...props}>
      {children}
    </div>
  );
}
