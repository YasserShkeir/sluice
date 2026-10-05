// SPDX-License-Identifier: Apache-2.0
/**
 * localSessionCredentials, driven by fake locate/read and a pinned platform, so
 * no Chrome profile or Keychain is ever touched. Every value is a placeholder.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { NoChromeSessionError } from '@sluice/core';
import type { CredentialBundle, WorkspaceInfo } from '@sluice/core';
import { localSessionCredentials } from './credentials.js';
import type { LocalSessionSpec } from './credentials.js';

const WORKSPACE: WorkspaceInfo = { id: 'example', name: 'Example', domain: 'example.com', url: 'https://example.com/' };
const BUNDLE: Pick<CredentialBundle, 'values' | 'injection'> = {
  values: { cookieHeader: 'COOKIE-VALUE' },
  injection: { headers: { Cookie: 'cookieHeader' } },
};

function spec(over: Partial<LocalSessionSpec> = {}): LocalSessionSpec {
  return {
    adapterId: 'example',
    label: 'Example',
    kind: 'example-session',
    workspace: WORKSPACE,
    locate: () => ({ profile: 'Default' }),
    read: () => BUNDLE,
    platform: 'darwin',
    ...over,
  };
}

test('a locate hit reports a fresh copy of the workspace', async () => {
  const p = localSessionCredentials(spec());
  const [first] = await p.listWorkspaces();
  assert.deepEqual(first, WORKSPACE);
  assert.notEqual(first, WORKSPACE, 'a caller mutating the result must not change the next answer');
});

test('a locate miss or a locate throw reports no workspace', async () => {
  assert.deepEqual(await localSessionCredentials(spec({ locate: () => undefined })).listWorkspaces(), []);
  const throwing = spec({
    locate: () => {
      throw new Error('database is locked');
    },
  });
  assert.deepEqual(await localSessionCredentials(throwing).listWorkspaces(), []);
});

test('off macOS both methods answer [] without calling locate or read', async () => {
  let calls = 0;
  const p = localSessionCredentials(
    spec({
      platform: 'linux',
      locate: () => {
        calls++;
        return true;
      },
      read: () => {
        calls++;
        return BUNDLE;
      },
    }),
  );
  assert.deepEqual(await p.listWorkspaces(), []);
  assert.deepEqual(await p.extractSessions(), []);
  assert.equal(calls, 0);
});

test('a read yields exactly one local-store Session carrying the bundle', async () => {
  const sessions = await localSessionCredentials(spec()).extractSessions();
  assert.equal(sessions.length, 1);
  const [s] = sessions;
  assert.ok(s);
  assert.equal(s.adapterId, 'example');
  assert.equal(s.label, 'Example');
  assert.equal(s.source, 'local-store');
  assert.match(s.id, /^sess/);
  assert.deepEqual(s.credentials, { kind: 'example-session', ...BUNDLE });
});

test('signed out is no sessions: NoChromeSessionError and the legacy messages', async () => {
  for (const err of [
    new NoChromeSessionError('No Chrome profile with example.com cookies found'),
    new Error('No Chrome profile with example.com cookies found — sign in first.'),
    new Error("ENOENT: no such file or directory, open 'Cookies'"),
  ]) {
    const p = localSessionCredentials(
      spec({
        read: () => {
          throw err;
        },
      }),
    );
    assert.deepEqual(await p.extractSessions(), [], err.message);
  }
});

test('a decrypt, lock or Keychain failure is reported, never passed off as signed out', async () => {
  // Core's "had no decryptable … cookies" means rows exist and could not be
  // decrypted. An earlier `no .*cookie` regex swallowed it as "not signed in".
  for (const message of [
    'Chrome profile "Default" had no decryptable example.com cookies — is your session in this profile?',
    'database is locked',
    'The specified item could not be found in the keychain.',
  ]) {
    const p = localSessionCredentials(
      spec({
        read: () => {
          throw new Error(message);
        },
      }),
    );
    await assert.rejects(p.extractSessions(), (e: Error) => {
      assert.equal(e.message, `Example credential extraction failed: ${message}`);
      return true;
    });
  }
});
