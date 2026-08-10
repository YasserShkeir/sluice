// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * `cn` — the class-name merger every shadcn component expects.
 *
 * clsx resolves conditionals; tailwind-merge resolves CONFLICTS. Without the
 * second half, `cn('px-2', props.className)` where the caller passes `px-4`
 * emits both, and which one wins comes down to their order in the generated
 * stylesheet — a bug that reproduces only in a production build, because dev
 * and build order differ.
 */
import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}
