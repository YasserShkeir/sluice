// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * The traffic table and the inspector, side by side and resizable.
 *
 * The inspector used to be a drawer floating over the table's right edge, which
 * covered Status, Size and Duration — the three columns you are comparing
 * against when you open a row in the first place. As a panel it takes space from
 * the table instead of hiding it, and the split is yours to set.
 *
 * The inspector panel is conditional; the table panel never is. Keeping the
 * table as the group's first child in both cases is what stops React remounting
 * it on every selection — a remount would empty its ingest buffer, its marks and
 * its filter, which is the entire state of a debugging session.
 */
import { useMemo } from 'react';
import { useDefaultLayout } from 'react-resizable-panels';
import type { Capture } from '@sluice/core';
import { TrafficDashboard } from '../components/TrafficDashboard.js';
import { CaptureInspector } from '../components/CaptureInspector.js';
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from '../ui/resizable.js';
import type { ConnectionState } from '../ws.js';

interface Props {
  captures: Capture[];
  connection: ConnectionState;
  capturePaused: boolean;
  noticeId: number;
  appFilter: string;
  /** already re-resolved against the live store by the shell */
  selected: Capture | null;
  onSelect: (c: Capture | null) => void;
}

export function TrafficPage({
  captures,
  connection,
  capturePaused,
  noticeId,
  appFilter,
  selected,
  onSelect,
}: Props) {
  const open = selected !== null;
  // The saved layout is keyed by the panels present, so the width you set for a
  // two-panel split is not restored over a one-panel one.
  const panelIds = useMemo(() => (open ? ['table', 'inspector'] : ['table']), [open]);
  const layout = useDefaultLayout({
    id: 'sluice-traffic',
    panelIds,
    storage: typeof localStorage === 'undefined' ? undefined : localStorage,
  });

  return (
    <ResizablePanelGroup
      orientation="horizontal"
      defaultLayout={layout.defaultLayout}
      onLayoutChanged={layout.onLayoutChanged}
    >
      <ResizablePanel id="table" minSize="30" defaultSize="62">
        <TrafficDashboard
          captures={captures}
          connection={connection}
          appFilter={appFilter}
          selectedId={selected?.id ?? null}
          onSelect={onSelect}
          noticeId={noticeId}
          capturePaused={capturePaused}
        />
      </ResizablePanel>

      {selected ? (
        <>
          <ResizableHandle orientation="horizontal" />
          <ResizablePanel id="inspector" minSize="20" defaultSize="38">
            <CaptureInspector key={selected.id} capture={selected} onClose={() => onSelect(null)} />
          </ResizablePanel>
        </>
      ) : null}
    </ResizablePanelGroup>
  );
}
