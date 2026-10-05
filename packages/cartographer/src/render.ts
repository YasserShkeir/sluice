// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Human-readable API docs from an ApiMap — one Markdown section per endpoint.
 * Purely a projection of the ApiMap, which keeps names and shapes, never values;
 * it introduces no new data. A JSON key is a name, though, so a response keyed
 * by record id renders every id (see the Notion `recordMap` test).
 */
import type { ApiMap } from './map.js';
import type { JsonSchema } from './infer.js';

function typeLabel(s: JsonSchema): string {
  return s.types.length ? s.types.join(' | ') : 'unknown';
}

/**
 * Indented bullet lines describing a schema node's nested shape. Child lines are
 * appended in a loop, not `out.push(...lines)`: a spread passes one argument per
 * line and V8 overflows the stack past ~100k (see the Notion `recordMap` test).
 */
function renderSchema(schema: JsonSchema, depth: number): string[] {
  const pad = '  '.repeat(depth + 1);
  const out: string[] = [];
  if (schema.properties) {
    for (const key of Object.keys(schema.properties).sort()) {
      const child = schema.properties[key];
      if (!child) continue;
      const flags = child.nullable ? ' (nullable)' : '';
      const seen =
        child.present !== undefined && child.total !== undefined
          ? ` [${child.present}/${child.total}]`
          : '';
      out.push(`${pad}- ${key}: ${typeLabel(child)}${flags}${seen}`);
      for (const line of renderSchema(child, depth + 1)) out.push(line);
    }
  }
  if (schema.items) {
    out.push(`${pad}- [items]: ${typeLabel(schema.items)}${schema.items.nullable ? ' (nullable)' : ''}`);
    for (const line of renderSchema(schema.items, depth + 1)) out.push(line);
  }
  return out;
}

/** Render the endpoint catalog as Markdown docs. */
export function renderMarkdown(map: ApiMap): string {
  const lines: string[] = [];
  lines.push('# API Catalog');
  lines.push('');
  lines.push(
    `_${map.endpoints.length} endpoint(s) • generated ${new Date(map.generatedAt).toISOString()}_`,
  );
  lines.push('');

  for (const ep of map.endpoints) {
    lines.push(`## ${ep.method} ${ep.path}`);
    lines.push('');
    lines.push(`- Samples: ${ep.sampleCount}`);
    lines.push(`- Statuses: ${ep.statuses.length ? ep.statuses.join(', ') : '(none)'}`);
    lines.push(`- Request params: ${ep.requestParams.length ? ep.requestParams.join(', ') : '(none)'}`);
    lines.push(
      `- Response headers: ${ep.responseHeaders.length ? ep.responseHeaders.join(', ') : '(none)'}`,
    );
    lines.push('');
    lines.push('Response schema:');
    lines.push('');
    const tree = renderSchema(ep.responseSchema, 0);
    lines.push(tree.length ? tree.join('\n') : '  (no JSON body observed)');
    lines.push('');
  }

  return lines.join('\n');
}
