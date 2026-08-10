// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Resizable panels, over `react-resizable-panels` v4, styled to Sluice's palette.
 *
 * The layout this replaces gave every region a hardcoded share of the viewport:
 * the overview took a fixed 45%, the traffic region 55%, and the app catalog was
 * left with `flex: 1` of the nothing that remained. So the catalog rendered a few
 * pixels tall no matter how much you wanted to look at it, and scrolling did not
 * help, because the constraint was the panel's height rather than its content's.
 *
 * Splitting beats picking better percentages, because the right split genuinely
 * depends on what you are doing: reading the traffic table wants the bottom,
 * comparing app coverage wants the top, and no single default is right for both.
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
 * Deliberately thicker than a hairline. A 1px divider is findable with a mouse
 * only by accident, and the entire point of the change is that the split is
 * adjustable — so the band is a real hit target, and it takes the accent colour
 * on hover and while dragging so the affordance announces itself before you
 * commit to the drag. Double-click resets the pair to an even split, which
 * `react-resizable-panels` gives us for free.
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
