// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * app-linkedin tests. Run with:
 *   node --import tsx --test src/*.test.ts   (from this package)
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { makeCapture, makeJsonCapture, runConformance } from '@sluice/adapter-sdk';
import type { Capture, ReadOnlyStore, Session } from '@sluice/core';
import {
  ADAPTER_ID,
  JOBS_CONTAINER_ID,
  buildLinkedInReplayRequest,
  classifyLinkedInCapture,
  csrfTokenFromCookieHeader,
  extractLinkedInCredentialHints,
  linkedinAdapter,
  linkedinApp,
  linkedinMcpTools,
  parseLinkedInCapture,
} from './index.js';

function capture(over: Partial<Capture> = {}): Capture {
  return makeCapture({
    adapterId: ADAPTER_ID,
    method: 'GET',
    url: 'https://www.linkedin.com/voyager/api/me',
    host: 'www.linkedin.com',
    path: '/voyager/api/me',
    ...over,
  });
}

const liJson = (path: string, body: unknown, over: Partial<Capture> = {}): Capture =>
  makeJsonCapture('www.linkedin.com', path, body, {
    adapterId: ADAPTER_ID,
    url: `https://www.linkedin.com${path}`,
    ...over,
  });

const SESSION: Session = {
  id: 's1',
  adapterId: ADAPTER_ID,
  label: 'LinkedIn',
  credentials: {
    kind: 'linkedin-session',
    values: {
      cookieHeader: 'li_at=REAL; JSESSIONID="ajax:TESTCSRF"',
      csrfToken: 'ajax:TESTCSRF',
    },
    injection: {
      headers: { Cookie: 'cookieHeader', 'csrf-token': 'csrfToken' },
    },
  },
  discoveredAt: 0,
  source: 'local-store',
};

function emptyStore(): ReadOnlyStore {
  return {
    listWorkspaces: () => [],
    listContainers: () => [],
    listItems: () => [],
    queryItems: () => [],
    countItems: () => 0,
    searchItems: () => [],
    listEdges: () => [],
    countCaptures: () => 0,
    newestCaptureTs: () => null,
  };
}

test('matchRequest claims linkedin hosts only', () => {
  const hit = (host: string) =>
    linkedinAdapter.matchRequest({ host, path: '/', method: 'GET', url: '' });
  assert.ok(hit('linkedin.com'));
  assert.ok(hit('www.linkedin.com'));
  assert.ok(!hit('licdn.com'));
  assert.ok(!hit('linkedin.com.evil.test'));
  assert.ok(!hit('slack.com'));
});

test('parse never throws on a malformed or irrelevant body', () => {
  assert.doesNotThrow(() => parseLinkedInCapture(capture({ resBody: '{not json' })));
  assert.doesNotThrow(() => parseLinkedInCapture(capture({ resBody: null })));
  assert.doesNotThrow(() => parseLinkedInCapture(capture({ host: 'example.com' })));
});

test('parses /voyager/api/me into workspace + actor + workspace.raw me summary', () => {
  const r = parseLinkedInCapture(
    liJson('/voyager/api/me', {
      data: {
        plainId: 123,
        '*miniProfile': 'urn:li:fs_miniProfile:ACoTEST',
        $type: 'com.linkedin.voyager.common.Me',
      },
      included: [
        {
          firstName: 'Ada',
          lastName: 'Lovelace',
          publicIdentifier: 'ada-lovelace',
          occupation: 'Mathematician',
          entityUrn: 'urn:li:fs_miniProfile:ACoTEST',
          dashEntityUrn: 'urn:li:fsd_profile:ACoTEST',
          objectUrn: 'urn:li:member:123',
          $type: 'com.linkedin.voyager.identity.shared.MiniProfile',
        },
      ],
    }),
  );
  assert.equal(r.workspaces?.[0]?.id, 'linkedin');
  const raw = r.workspaces?.[0]?.raw as Record<string, unknown> | undefined;
  assert.equal(raw?.publicIdentifier, 'ada-lovelace');
  assert.equal(raw?.displayName, 'Ada Lovelace');
  assert.ok(r.actors && r.actors.length >= 1);
  const me = r.actors!.find((a) => a.handle === 'ada-lovelace') ?? r.actors![0];
  assert.equal(me!.displayName, 'Ada Lovelace');
  assert.equal(me!.id, 'ACoTEST');
});

test('parses job postings from included GraphQL payload', () => {
  const r = parseLinkedInCapture(
    liJson(
      '/voyager/api/graphql',
      {
        data: {},
        included: [
          {
            entityUrn: 'urn:li:fsd_jobPosting:4411433744',
            title: 'Software Engineering Manager',
            listedAt: 1_700_000_000_000,
            companyDetails: { name: 'Coda' },
            formattedLocation: 'Remote',
            $type: 'com.linkedin.voyager.dash.jobs.JobPosting',
          },
          {
            entityUrn: { type: 'string' },
            title: { type: 'string' },
          },
        ],
      },
      {
        url: 'https://www.linkedin.com/voyager/api/graphql?queryId=voyagerJobsDashJobPostings.abc',
      },
    ),
  );
  assert.ok(r.items && r.items.length === 1);
  assert.equal(r.items![0]!.id, 'job:4411433744');
  assert.equal(r.items![0]!.containerId, JOBS_CONTAINER_ID);
  assert.match(r.items![0]!.text, /Software Engineering Manager/);
  assert.match(r.items![0]!.text, /Coda/);
  assert.ok(r.containers?.some((c) => c.id === JOBS_CONTAINER_ID));
});

test('stitches company and location from JobPostingCard onto bare JobPosting', () => {
  const r = parseLinkedInCapture(
    liJson(
      '/voyager/api/voyagerJobsDashJobCards',
      {
        data: {},
        included: [
          {
            entityUrn: 'urn:li:fsd_jobPosting:4407825293',
            title: 'Software Developer',
            $type: 'com.linkedin.voyager.dash.jobs.JobPosting',
          },
          {
            entityUrn: 'urn:li:fsd_jobPostingCard:(4407825293,JOB_DETAILS)',
            '*jobPosting': 'urn:li:fsd_jobPosting:4407825293',
            jobPostingUrn: 'urn:li:fsd_jobPosting:4407825293',
            primaryDescription: { text: 'Proalpha' },
            secondaryDescription: { text: 'Phuket, Thailand (On-site)' },
            $type: 'com.linkedin.voyager.dash.jobs.JobPostingCard',
          },
        ],
      },
      {
        url: 'https://www.linkedin.com/voyager/api/voyagerJobsDashJobCards?q=jobSearch&query=(keywords:django)',
      },
    ),
  );
  assert.equal(r.items?.length, 1);
  const job = r.items![0]!;
  assert.equal(job.id, 'job:4407825293');
  assert.match(job.text, /Software Developer/);
  assert.match(job.text, /Proalpha/);
  assert.match(job.text, /Phuket/);
  const raw = job.raw as Record<string, unknown>;
  assert.equal(raw.companyName, 'Proalpha');
});

test('parses messaging conversations and messages', () => {
  const convUrn = 'urn:li:msg_conversation:(urn:li:fsd_profile:ACoME,2-THREADID)';
  const r = parseLinkedInCapture(
    liJson('/voyager/api/voyagerMessagingGraphQL/graphql', {
      data: {
        messengerConversationsBySyncToken: {
          elements: [
            {
              entityUrn: convUrn,
              backendUrn: 'urn:li:messagingThread:2-THREADID',
              lastActivityAt: 1_700_000_100_000,
              unreadCount: 1,
              conversationParticipants: [
                {
                  hostIdentityUrn: 'urn:li:fsd_profile:ACoOTHER',
                  entityUrn: 'urn:li:msg_messagingParticipant:urn:li:fsd_profile:ACoOTHER',
                  participantType: {
                    member: {
                      firstName: { text: 'Grace' },
                      lastName: { text: 'Hopper' },
                    },
                  },
                },
              ],
            },
          ],
        },
      },
      included: [
        {
          entityUrn: 'urn:li:msg_message:MSG1',
          backendUrn: 'urn:li:messagingMessage:MSG1',
          backendConversationUrn: 'urn:li:messagingThread:2-THREADID',
          deliveredAt: 1_700_000_100_000,
          body: { text: 'Hello from LinkedIn' },
          _type: 'com.linkedin.messenger.Message',
        },
      ],
    }),
  );
  assert.ok(r.containers?.some((c) => c.kind === 'thread'));
  const thread = r.containers!.find((c) => c.kind === 'thread')!;
  assert.match(thread.name, /Grace/);
  assert.equal(thread.unreadCount, 1);
  assert.ok(r.items?.some((i) => i.kind === 'message' && i.text.includes('Hello')));
  assert.ok(r.actors?.some((a) => a.displayName === 'Grace Hopper'));
});

test('classify marks me as auth, jobs as messages, assets as asset', () => {
  assert.equal(classifyLinkedInCapture(capture()).class, 'auth');
  assert.equal(
    classifyLinkedInCapture(
      capture({
        path: '/voyager/api/voyagerJobsDashJobCards',
        url: 'https://www.linkedin.com/voyager/api/voyagerJobsDashJobCards',
      }),
    ).class,
    'messages',
  );
  assert.equal(
    classifyLinkedInCapture(
      capture({
        path: '/static/js/app.js',
        url: 'https://www.linkedin.com/static/js/app.js',
      }),
    ).class,
    'asset',
  );
  assert.equal(
    classifyLinkedInCapture(
      capture({
        path: '/voyager/api/me',
        status: 401,
      }),
    ).class,
    'error',
  );
});

test('buildReplayRequest injects Cookie and csrf-token', () => {
  const actions = linkedinAdapter.listReplayActions();
  const me = actions.find((a) => a.id === 'linkedin.me')!;
  const req = buildLinkedInReplayRequest(me, {}, SESSION);
  assert.equal(req.method, 'GET');
  assert.equal(req.url, 'https://www.linkedin.com/voyager/api/me');
  assert.equal(req.headers?.Cookie, SESSION.credentials.values.cookieHeader);
  assert.equal(req.headers?.['csrf-token'], 'ajax:TESTCSRF');
  assert.ok(req.headers?.['x-restli-protocol-version']);

  const gql = actions.find((a) => a.id === 'linkedin.graphql')!;
  const greq = buildLinkedInReplayRequest(gql, { queryId: 'voyagerJobsDashJobCards.abc' }, SESSION);
  assert.match(greq.url, /queryId=voyagerJobsDashJobCards\.abc/);

  const jobs = actions.find((a) => a.id === 'linkedin.jobs.search')!;
  const jreq = buildLinkedInReplayRequest(jobs, { keywords: 'django' }, SESSION);
  assert.match(jreq.url, /voyagerJobsDashJobCards/);
  assert.match(jreq.url, /keywords:django/);
  assert.match(jreq.url, /q=jobSearch/);
  assert.equal(jreq.headers?.Cookie, SESSION.credentials.values.cookieHeader);
  assert.equal(jreq.headers?.['csrf-token'], 'ajax:TESTCSRF');
});

test('csrfTokenFromCookieHeader reads quoted JSESSIONID', () => {
  assert.equal(
    csrfTokenFromCookieHeader('li_at=x; JSESSIONID="ajax:ABC123"; foo=bar'),
    'ajax:ABC123',
  );
  assert.equal(csrfTokenFromCookieHeader('nope=1'), undefined);
});

test('extractCredentialHints reports presence without secrets', () => {
  const hints = extractLinkedInCredentialHints(
    capture({
      reqHeaders: {
        Cookie: '«redacted»',
        'csrf-token': '«redacted»',
      },
    }),
  );
  assert.ok(hints.some((h) => h.role === 'session-cookie'));
  assert.ok(hints.some((h) => h.role === 'csrf'));
  for (const h of hints) {
    assert.ok(!h.valuePreview.includes('ajax:'));
  }
});

test('MCP tools are named linkedin_* and declare schemas', () => {
  const tools = linkedinMcpTools();
  assert.ok(tools.length >= 5);
  for (const t of tools) {
    assert.match(t.name, /^linkedin_/);
    assert.ok(t.description.length > 10);
    assert.equal(typeof t.run, 'function');
  }
  const names = new Set(tools.map((t) => t.name));
  assert.ok(names.has('linkedin_sync_status'));
  assert.ok(names.has('linkedin_list_jobs'));
  assert.ok(names.has('linkedin_me'));
});

test('MCP store tools refuse without store and empty-store safely', async () => {
  const tools = linkedinMcpTools();
  const status = tools.find((t) => t.name === 'linkedin_sync_status')!;
  await assert.rejects(() => status.run({}), /store/i);

  const out = (await status.run(
    {},
    { replay: async () => capture(), store: emptyStore() },
  )) as { jobs: number; items: number; captures: number };
  assert.equal(out.jobs, 0);
  assert.equal(out.items, 0);
  assert.equal(out.captures, 0);
});

test('app exports id linkedin and mcpTools', () => {
  assert.equal(linkedinApp.id, 'linkedin');
  assert.equal(linkedinApp.displayName, 'LinkedIn');
  assert.ok(linkedinApp.credentials);
  assert.ok((linkedinApp.mcpTools?.() ?? []).length >= 5);
});

runConformance(linkedinApp, { session: SESSION });
