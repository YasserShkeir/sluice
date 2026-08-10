# @sluice/mcp

Local MCP server that exposes this machine’s Sluice store to agents: workspaces,
containers, items, captures, **single-request replay**, and **multi-step
interaction flows**.

Binary: `sluice-mcp` (stdio). Until packaging lands, run via tsx:

```bash
claude mcp add sluice -- pnpm --dir /path/to/sluice exec tsx packages/mcp/src/cli.ts
```

## Secrets

- The store never holds live credentials. Replay acquires a `Session` in-memory
  (Keychain / local browser profile) and never writes `credentials.values` to
  SQLite, tool results, or logs.
- Tool errors pass through redaction before leaving the process.
- Flow describe/list return binding **kinds and names only** — never token
  values, cookies, or full bodies.

## Flow tools (multi-step)

| Tool | Role |
|------|------|
| `sluice_list_flows` | Observed/pinned bursts + learned templates (ids, primaryKey, sampleCount, qualityNotes) |
| `sluice_describe_flow` | Step plan: roles, offsets, param kinds, unreproducible flags |
| `sluice_replay_flow` | Sequential read-only run via `buildFlowStepRequest` + `runFlowReplay` + `runReplay` |

### Agent contract (from live Trello/Slack capture)

1. **Learn offline** — MCP does not cluster. After browsing under capture, run
   `sluice learn-flows --adapter <id>`. Then list/describe/replay.
2. **Prefer quality templates** — `sampleCount ≥ 2`, `primaryKey` is a real API
   op (`cards/:id`, `boards/:id`, `conversations.history`), not `assets/*` or a
   hashed SPA filename. Use `qualityNotes` on list/describe.
3. **Describe before replay** — supply every required `flowParam`; pick
   `workspaceId` when multiple sessions exist.
4. **Correlation** — MITM/WS captures have no `pageLoadId`/`loaderId`; bursts are
   **time-window** clustered. CDP populates loader ids when that engine is on.
   WebSocket frames are **excluded** from HTTP flow clustering.
5. **Pacing** — companions use `offsetFromPrimaryMsP50` (ms from primary start,
   hard-capped). Negative offsets mean the companion was observed *before* the
   learned primary (auth/bootstrap); replay fires those immediately if still
   pending. Fallback: chained `delayMsP50`.
6. **Rails (F4.4)** — each step: GET|HEAD|POST only, write-op denylist, host must
   match `app.hosts`. Soft unreproducible companions skip; required failures stop.
7. **No writes** — flow replay is not for create/update/delete.
8. **Assets** — SPA bundles are deprioritized as primaries and dropped from
   learned templates as soft companions; do not treat asset primaries as actions.

App tools that need multiple hops must use `ctx.replayFlow(templateId, params)`
(or `ctx.replay` per hop), not bare `fetch`. See
`.claude/skills/sluice-mcp-tool/SKILL.md`.

## Single replay

`sluice_replay` / app `ctx.replay`: one action id → faithful fingerprint →
`runReplay` → store. Same rails and redaction as flow steps.

## Related

- CLI: `sluice flows`, `sluice learn-flows`, `sluice replay --flow`
- Learning: `packages/cartographer` (`flows.ts`, `flow-learn.ts`, `flow-build.ts`)
- Executor: `packages/interceptor/src/flow-replay.ts`
- Tracker: `docs/FULL-FLOW-FIDELITY.md` (local)
