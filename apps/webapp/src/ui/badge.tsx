// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Badge — small status chips for the traffic table.
 *
 * The `tone` variants are semantic, not decorative: `ok`/`warn`/`err` map to the
 * same tokens the KPI tiles and charts already use, so a 429 is the same amber
 * everywhere it appears. A component that picked its own colours would make two
 * views of the same fact disagree.
 */
import { cva, type VariantProps } from 'class-variance-authority';
import type { ComponentProps } from 'react';
import { cn } from './cn.js';

const badge = cva(
  'inline-flex items-center rounded-sm border px-1 font-mono text-[11px] leading-[16px]',
  {
    variants: {
      tone: {
        neutral: 'border-border-2 bg-bg-3 text-fg-dim',
        ok: 'border-ok/40 bg-ok/10 text-ok',
        info: 'border-info/40 bg-info/10 text-info',
        warn: 'border-warn/40 bg-warn/10 text-warn',
        err: 'border-err/40 bg-err/10 text-err',
        none: 'border-none/40 bg-none/10 text-fg-mute',
      },
    },
    defaultVariants: { tone: 'neutral' },
  },
);

export type BadgeProps = ComponentProps<'span'> & VariantProps<typeof badge>;

export function Badge({ className, tone, ...props }: BadgeProps) {
  return <span className={cn(badge({ tone }), className)} {...props} />;
}

/** The tone an HTTP status deserves. Null (a WS frame) is not an error. */
export function statusTone(status: number | null): NonNullable<BadgeProps['tone']> {
  if (status === null) return 'none';
  if (status >= 500) return 'err';
  if (status === 429) return 'warn';
  if (status >= 400) return 'err';
  if (status >= 300) return 'info';
  return 'ok';
}
