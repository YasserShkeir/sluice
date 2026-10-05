// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Resizable panels, over `react-resizable-panels` v4, styled to Sluice's palette.
 *
 * Note v4's sizing rule, which is easy to get backwards: a NUMBER is pixels, a
 * numeric STRING is a percentage. Every size here is a string on purpose.
 */
import { GripHorizontal, GripVertical } from 'lucide-react';
import type { ComponentProps } from 'react';
import { Group, Panel, Separator } from 'react-resizable-panels';
import type { Orientation } from 'react-resizable-panels';
import { cn } from './cn.js';

export const ResizablePanel = Panel;

export function ResizablePanelGroup({ className, ...props }: ComponentProps<typeof Group>) {
  return <Group className={cn('h-full w-full', className)} {...props} />;
}

/**
 * The draggable divider, and the visible border between two sections.
 *
 * Thicker than a hairline so it is a real hit target; accent on hover and while
 * dragging. Double-click resets the pair to an even split (built into
 * `react-resizable-panels`).
 *
 * `orientation` names the GROUP's orientation, not the bar's, so a caller writes
 * the same word on the group and on its handles. A vertical group stacks panels,
 * so its handle is a horizontal bar you drag up and down.
 */
export function ResizableHandle({
  className,
  orientation = 'vertical',
  ...props
}: ComponentProps<typeof Separator> & { orientation?: Orientation }) {
  const Grip = orientation === 'vertical' ? GripHorizontal : GripVertical;
  return (
    <Separator
      className={cn(
        'group relative flex shrink-0 items-center justify-center bg-border transition-colors',
        'hover:bg-accent data-[state=dragging]:bg-accent',
        'focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent',
        orientation === 'vertical' ? 'h-[5px] w-full cursor-row-resize' : 'h-full w-[5px] cursor-col-resize',
        className,
      )}
      {...props}
    >
      <Grip
        className="h-2.5 w-2.5 text-fg-mute opacity-0 transition-opacity group-hover:opacity-100"
        aria-hidden
      />
    </Separator>
  );
}
