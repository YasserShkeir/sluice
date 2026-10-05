// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Toters MCP tools — all three answer from the capture store, none touch the
 * network.
 *
 * That is a decision, not an omission. An app tool's `ctx.replay` runs under a
 * SYNTHETIC session: the MCP server hands it to `faithfulReplayRequest`, which
 * overlays the real client's learned fingerprint but deliberately SKIPS any
 * header whose captured value was redacted — so the captured
 * `Authorization: «redacted»` is dropped rather than replayed. Toters keeps its
 * bearer token in the phone's keystore, which this machine cannot read, so a
 * live tool would have nowhere to get a working credential and would answer
 * every question with a 401.
 *
 * Reading what was already captured is the honest capability, and it is the one
 * that needs no credential at all. For a live call, use the CLI paste-in:
 * `sluice replay <actionId> --adapter toters --token -`. The MCP `replay` tool
 * has no paste-in.
 */
import { z } from 'zod';
import { num, obj, pageArgs, requireStore, str } from '@sluice/adapter-sdk';
import type { AppMcpTool } from '@sluice/core';
import { ADAPTER_ID, WORKSPACE_ID } from './toters-adapter.js';

export const totersMcpTools: AppMcpTool[] = [
  {
    name: 'toters_stores',
    description:
      'List the Toters stores captured from this account: id, name, type, rating and whether it was open. Reads the local capture store; makes no network request.',
    // A zod RAW SHAPE, which is what the MCP SDK's registerTool expects — a
    // plain JSON-Schema-looking object is rejected outright. `@sluice/core`
    // stays zod-free by typing this structurally; the dependency lives here.
    inputSchema: {
      limit: z.number().int().positive().max(500).optional(),
      search: z.string().optional(),
    },
    run: async (args, ctx) => {
      const store = requireStore(ctx);
      const { limit } = pageArgs(args);
      const search = typeof args.search === 'string' ? args.search.toLowerCase() : undefined;

      // `listContainers` filters by workspace only, so the adapter check is
      // ours to make — a shared store holds every app's containers.
      const containers = store.listContainers(WORKSPACE_ID);
      const stores = containers
        .filter((c) => c.adapterId === ADAPTER_ID && c.id.startsWith('store:'))
        .filter((c) => (search ? c.name.toLowerCase().includes(search) : true))
        .slice(0, limit)
        .map((c) => {
          const raw = obj(c.raw) ?? {};
          return {
            id: c.id.slice('store:'.length),
            name: c.name,
            type: str(raw.type),
            storeType: str(raw.store_type),
            rating: str(raw.rating) ?? num(raw.rating),
            isOpen: raw.is_open === true,
            minimumOrder: num(raw.minimum_order),
          };
        });
      return { count: stores.length, stores };
    },
  },

  {
    name: 'toters_store_items',
    description:
      'List the captured catalogue items for one Toters store, by store id. Reads the local capture store; makes no network request.',
    inputSchema: {
      storeId: z.string(),
      limit: z.number().int().positive().max(1000).optional(),
    },
    run: async (args, ctx) => {
      const store = requireStore(ctx);
      const storeId = typeof args.storeId === 'string' ? args.storeId : String(args.storeId ?? '');
      if (!/^\d+$/.test(storeId)) {
        throw new Error('storeId must be a numeric Toters store id (see toters_stores).');
      }
      const { limit } = pageArgs(args, { defaultLimit: 100, maxLimit: 1000 });

      const items = store
        .queryItems({ adapterId: ADAPTER_ID, containerId: `store:${storeId}`, limit })
        .map((i) => {
          const raw = obj(i.raw) ?? {};
          return {
            id: i.id.slice('item:'.length),
            name: i.text,
            description: str(raw.short_description) ?? str(raw.description),
            measurement: str(raw.measurement_unit),
            image: str(raw.image),
          };
        });
      return { storeId, count: items.length, items };
    },
  },

  {
    name: 'toters_coverage',
    description:
      'Report how much Toters traffic has been captured: totals per host, when the newest capture landed, and how many stores and items were parsed out of it. Use this to tell whether a question can be answered from the store at all. Reads the local capture store; makes no network request.',
    run: async (_args, ctx) => {
      const store = requireStore(ctx);
      // ReadOnlyStore deliberately exposes no capture LISTING — only counts and
      // a newest-timestamp — so this summarises rather than scanning. A tool
      // that wants raw exchanges should use the core `sluice_captures` tool.
      const hosts = ['api.toters-api.com', 'search-service.prod.toters-api.com', 'images.toters-api.com'];
      const byHost = hosts.map((host) => ({
        host,
        captures: store.countCaptures({ adapterId: ADAPTER_ID, host }),
        newestTs: store.newestCaptureTs({ adapterId: ADAPTER_ID, host }),
      }));
      const containers = store
        .listContainers(WORKSPACE_ID)
        .filter((c) => c.adapterId === ADAPTER_ID);
      return {
        totalCaptures: store.countCaptures({ adapterId: ADAPTER_ID }),
        newestCaptureTs: store.newestCaptureTs({ adapterId: ADAPTER_ID }),
        byHost,
        stores: containers.filter((c) => c.id.startsWith('store:')).length,
        addresses: containers.filter((c) => c.id.startsWith('address:')).length,
        items: store.countItems({ adapterId: ADAPTER_ID }),
      };
    },
  },
];
