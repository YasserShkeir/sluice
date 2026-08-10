// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Button — the shadcn primitive, restyled to Sluice's palette.
 *
 * Variants come from the theme tokens rather than Tailwind's default palette, so
 * a button matches the hand-written stylesheet it sits beside instead of
 * introducing a second, slightly-different blue.
 *
 * `asChild` renders the caller's element with these classes instead of a
 * `<button>`. That exists so a link can look like a button without becoming one:
 * a div with an onClick is not keyboard-reachable, and this file is where that
 * temptation would otherwise be satisfied.
 */
import { Slot } from '@radix-ui/react-slot';
import { cva, type VariantProps } from 'class-variance-authority';
import type { ComponentProps } from 'react';
import { cn } from './cn.js';

const button = cva(
  'inline-flex items-center justify-center gap-1.5 whitespace-nowrap rounded border font-medium ' +
    'transition-colors outline-none focus-visible:ring-2 focus-visible:ring-accent/60 ' +
    'disabled:pointer-events-none disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:shrink-0',
  {
    variants: {
      variant: {
        default: 'border-border-2 bg-bg-3 text-fg hover:bg-border-2',
        primary: 'border-accent bg-accent-dim text-fg hover:bg-accent hover:text-bg',
        ghost: 'border-transparent bg-transparent text-fg-dim hover:bg-bg-3 hover:text-fg',
        danger: 'border-err/40 bg-transparent text-err hover:bg-err/15',
      },
      size: {
        sm: 'h-6 px-2 text-[11px]',
        md: 'h-7 px-2.5 text-[12.5px]',
        icon: 'h-6 w-6 p-0',
      },
    },
    defaultVariants: { variant: 'default', size: 'md' },
  },
);

export type ButtonProps = ComponentProps<'button'> &
  VariantProps<typeof button> & { asChild?: boolean };

export function Button({ className, variant, size, asChild, ...props }: ButtonProps) {
  const Comp = asChild ? Slot : 'button';
  // An explicit default: a <button> inside a form submits it, and every button
  // in this app is an action, never a submit.
  return (
    <Comp type={asChild ? undefined : 'button'} className={cn(button({ variant, size }), className)} {...props} />
  );
}

export { button as buttonVariants };
