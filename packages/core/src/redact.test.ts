// SPDX-License-Identifier: Apache-2.0
/**
 * Redactor tests. Run with:
 *   node --import tsx --test src/*.test.ts   (from this package)
 *
 * This is the single sink guarding every write, and it had no coverage at all.
 * A regression here is a credential-leak class bug with no other detection, so
 * the cases below assert BOTH directions: secrets must be masked, and non-secret
 * values an app has vouched for must survive (otherwise captures stop being
 * replayable and people work around the redactor, which is worse).
 */
import assert from 'node:assert/strict';
import test, { afterEach } from 'node:test';
import {
  MASK,
  previewSecret,
  redactCaptureUrls,
  redactedErrorMessage,
  redactHeaders,
  redactText,
  redactUrl,
  registerAppRedaction,
  resetAppRedaction,
} from './redact.js';

afterEach(() => resetAppRedaction());

/** Stand-in for what @sluice/app-slack registers; core can't import an app package. */
function registerSlackLike(): void {
  registerAppRedaction([
    {
      redaction: {
        patterns: [/xox[abcdeprs]-[A-Za-z0-9-]{8,}/g, /xoxd-[A-Za-z0-9%._-]{8,}/g],
        headers: ['x-slack-auth'],
      },
    },
  ]);
}

test('generic policy masks credential-named fields', () => {
  for (const s of [
    'access_token=abcdefgh',
    '{"client_secret":"abcdefgh"}',
    'api_key: abcdefgh',
    '{"password":"hunter22"}',
  ]) {
    assert.ok(redactText(s).includes(MASK), `should have masked: ${s}`);
  }
});

test('generic policy masks Bearer values wherever they appear', () => {
  assert.ok(redactText('authorization: Bearer abcdefghijklmnop').includes(MASK));
});

test('always-secret headers are masked by name', () => {
  const out = redactHeaders({
    authorization: 'Bearer abcdefghijkl',
    cookie: 'd=xoxd-abcdefghijkl',
    'content-type': 'application/json',
  });
  assert.equal(out.authorization, MASK);
  assert.equal(out.cookie, MASK);
  assert.equal(out['content-type'], 'application/json', 'benign headers must survive');
});

test('credential-shaped header names are masked without per-app registration', () => {
  const out = redactHeaders({
    'x-api-key': 'sk-live-abcdefgh',
    'x-auth-token': 'tok-abcdefgh',
    'x-amz-security-token': 'FwoGZXIvYXdzE',
    'x-csrf-token': 'csrf-secret-value',
    'X-Session-Id': 'sess-abcdef',
    'content-type': 'application/json',
    accept: 'application/json',
    'user-agent': 'RealClient/1.0',
    'x-request-id': 'req-123',
  });
  assert.equal(out['x-api-key'], MASK);
  assert.equal(out['x-auth-token'], MASK);
  assert.equal(out['x-amz-security-token'], MASK);
  assert.equal(out['x-csrf-token'], MASK);
  assert.equal(out['X-Session-Id'], MASK);
  assert.equal(out['content-type'], 'application/json');
  assert.equal(out.accept, 'application/json');
  assert.equal(out['user-agent'], 'RealClient/1.0');
  assert.equal(out['x-request-id'], 'req-123', 'request-id is not credential-shaped');
  // Concatenated names, and short credential words.
  const secret = ['x-authtoken', 'X-CSRFToken', 'sessionid', 'x-accesstoken', 'x-access-key', 'x-jwt', 'x-bearer', 'x-sid', 'x-refreshtoken'];
  const benign = ['refresh', 'x-refresh-rate', 'x-goog-authuser', 'x-tokenizer', 'x-sidebar', 'access-control-allow-credentials'];
  const more = redactHeaders(Object.fromEntries([...secret, ...benign].map((n) => [n, 'opaque-value-123'])));
  for (const n of secret) assert.equal(more[n], MASK, n);
  for (const n of benign) assert.equal(more[n], 'opaque-value-123', n);
});

test('app-registered token shapes are masked under ANY field name', () => {
  // The generic policy knows credential-*named* fields and well-known token
  // shapes. An app's own shape under an innocuous name needs its contribution.
  const leaks = [
    '{"blob":"acmetok-abc123456789"}',
    '{"d":"acmetok-abcdefghijk"}',
    'some prose mentioning acmetok-1234567890abcdef inline',
  ];
  for (const s of leaks) {
    assert.ok(!redactText(s).includes(MASK), `precondition: generic policy misses ${s}`);
  }
  registerAppRedaction([{ redaction: { patterns: [/acmetok-[a-z0-9]{8,}/g] } }]);
  for (const s of leaks) {
    assert.ok(redactText(s).includes(MASK), `should be masked once registered: ${s}`);
  }
});

test('app-registered header names are masked', () => {
  registerSlackLike();
  assert.equal(redactHeaders({ 'X-Slack-Auth': 'anything' })['X-Slack-Auth'], MASK);
});

test('redactUrl masks query secrets by default', () => {
  const out = redactUrl('https://slack.com/api/conversations.list?token=xoxc-secret-here&limit=100');
  assert.ok(out.includes(MASK));
  assert.ok(out.includes('limit=100'), 'benign params must survive');
});

test('a param an app declares public survives on its hosts', () => {
  const url = 'https://api.fast.com/netflix/speedtest/v2?https=true&token=PUBLICTOKENVALUE&urlCount=5';
  assert.ok(redactUrl(url).includes(MASK), 'precondition: masked without a declaration');

  registerAppRedaction([
    { redaction: { publicParams: [{ hosts: ['fast.com'], params: ['token'] }] } },
  ]);
  assert.equal(redactUrl(url), url, 'declared-public param must round-trip exactly');
});

test('a public declaration does not weaken other params or other hosts', () => {
  registerAppRedaction([
    { redaction: { publicParams: [{ hosts: ['fast.com'], params: ['token'] }] } },
  ]);

  // Same host, different param → still masked.
  const mixed = redactUrl('https://api.fast.com/x?token=publicvalue&api_key=SUPERSECRET');
  assert.ok(mixed.includes('token=publicvalue'));
  assert.ok(!mixed.includes('SUPERSECRET'), 'a non-declared param must still be masked');

  // Different host, same param name → still masked.
  assert.ok(redactUrl('https://slack.com/api/x?token=xoxc-secret').includes(MASK));
});

test('redactUrl falls back to text rules for a non-URL string', () => {
  assert.ok(redactUrl('not a url at all token=abcdefgh').includes(MASK));
});

test('redactText tolerates null and undefined', () => {
  assert.equal(redactText(null), '');
  assert.equal(redactText(undefined), '');
});

// ── Value shapes: masked wherever they appear, under any field name ──────────

/**
 * Synthetic token of a real shape. Built at runtime so no token-shaped literal
 * sits in the source for secret scanners to flag — none of these are real.
 */
function synthetic(prefix: string, length: number, alphabet = 'FAKE0'): string {
  return prefix + alphabet.repeat(Math.ceil(length / alphabet.length)).slice(0, length);
}

const SHAPES: Record<string, string> = {
  'Anthropic API key': synthetic('sk-ant-api03-', 40),
  'Anthropic OAuth token': synthetic('sk-ant-oat01-', 40),
  'OpenAI project key': synthetic('sk-proj-', 48),
  'OpenAI legacy key': synthetic('sk-', 48),
  'Stripe secret key': synthetic('sk_live_', 24),
  JWT: `${synthetic('eyJ', 20)}.${synthetic('eyJ', 30)}.${synthetic('', 24)}`,
  'Google OAuth access token': synthetic('ya29.', 40),
  'Google OAuth refresh token': synthetic('1//0', 40),
  'Google API key': synthetic('AIza', 35),
  'AWS access key id': synthetic('AKIA', 16, 'FAKE7'),
  'AWS temporary key id': synthetic('ASIA', 16, 'FAKE7'),
  'GitHub PAT': synthetic('ghp_', 36),
  'GitHub OAuth token': synthetic('gho_', 36),
  'GitHub fine-grained PAT': synthetic('github_pat_', 40),
  'Slack user token': synthetic('xoxc-', 30),
  'Slack cookie token': synthetic('xoxd-', 30, 'FAKE%2F'),
  'Slack app token': synthetic('xapp-1-', 30),
  'OpenAI None key': synthetic('sk-None-', 40),
};

test('well-known token shapes are masked under any field name, without app registration', () => {
  for (const [what, value] of Object.entries(SHAPES)) {
    for (const text of [
      `{"blob":"${value}"}`,
      `note=${value}&x=1`,
      `plain prose ${value} inline`,
      `https://example.test/x?u=${encodeURIComponent(`"${value}"`)}`,
    ]) {
      const out = redactText(text);
      assert.ok(!out.includes(value), `${what} leaked from ${text} -> ${out}`);
      assert.ok(out.includes(MASK), `${what} should be masked in ${text}`);
    }
  }
});

test('token shapes do not fire inside longer runs or on short look-alikes', () => {
  for (const benign of [
    'the sk-short flag',
    'task-ant-farm',
    'AKIA is not a key on its own',
    'mask-proj-name',
    'akeyJwtIsNotHere',
    'deskey1//0',
    '/ad/sk-ii-facial-treatment-essence-230ml-limited-edition-ID1.html',
    'https://foxapp-cdn.example.com/a.js',
    '?q=ring+bearer+pillow+ideas',
  ]) {
    assert.equal(redactText(benign), benign);
  }
});

test('URL- and form-encoded Bearer values and twice-encoded refresh tokens are masked', () => {
  for (const [text, secret] of [
    ['h=Authorization%3A%20Bearer%20opaqueTOKEN123%2Bmore456&x=1', 'more456'],
    ['h=Authorization%3ABearer+opaqueTOKEN123', 'opaqueTOKEN123'],
    [`x=${synthetic('1%252F%252F0', 40)}`, 'FAKE0FAKE0'],
  ] as const) {
    assert.ok(!redactText(text).includes(secret), text);
  }
});

test('PEM private keys are masked whole, raw, JSON-escaped and truncated', () => {
  const body = synthetic('', 64, 'MIIEvQIBADAN');
  const raw = `-----BEGIN PRIVATE KEY-----\n${body}\n${body}\n-----END PRIVATE KEY-----\n`;
  const rsa = raw.replace(/PRIVATE KEY/g, 'RSA PRIVATE KEY');
  const escaped = JSON.stringify({ type: 'service_account', private_key: raw, client_email: 'svc@example.test' });
  const truncated = `-----BEGIN OPENSSH PRIVATE KEY-----\n${body}\n${body.slice(0, 20)}`;
  const encoded = `key=${encodeURIComponent(rsa)}&x=1`;
  for (const text of [
    raw,
    rsa,
    escaped,
    truncated,
    `key: ${raw}`,
    JSON.stringify({ p: JSON.stringify({ pem: raw }) }),
    raw.replace(/\n/g, '<br>'),
    encoded,
    encoded.slice(0, 200), // truncated, URL-encoded
    encoded.replace(/%20/g, '+').slice(0, 200), // truncated, form-encoded
  ]) {
    const out = redactText(text);
    assert.ok(!out.includes(body.slice(0, 16)), `PEM body leaked: ${out}`);
    assert.ok(out.includes(MASK));
  }
  const parsed = JSON.parse(redactText(escaped)) as Record<string, string>;
  assert.equal(parsed.type, 'service_account', 'the surrounding JSON stays well-formed');
  assert.equal(parsed.client_email, 'svc@example.test');
  // A public key or certificate is not a secret.
  const cert = `-----BEGIN CERTIFICATE-----\n${body}\n-----END CERTIFICATE-----`;
  assert.equal(redactText(cert), cert);
});

test('multipart/form-data parts are masked by part name and by value shape', () => {
  const b = '----SluiceBoundary7';
  const part = (name: string, value: string, extra = ''): string =>
    `--${b}\r\nContent-Disposition: form-data; name="${name}"\r\n${extra}\r\n${value}\r\n`;
  const opaque = 'OPAQUE-FAKE-VALUE-123';
  const slack = SHAPES['Slack user token'] as string;
  const body = [
    part('token', opaque),
    part('password', 'hunter2-fake'),
    part('x_auth_token', opaque, 'Content-Type: text/plain\r\n'),
    part('d', slack),
    part('channel', 'C0000000001'),
    part('text', 'hello world'),
    `--${b}--\r\n`,
  ].join('');
  const out = redactText(body);
  for (const secret of [opaque, 'hunter2-fake', slack]) {
    assert.ok(!out.includes(secret), `multipart value leaked: ${secret}`);
  }
  assert.ok(out.includes('C0000000001'), 'benign parts survive');
  assert.ok(out.includes('hello world'), 'benign parts survive');
  assert.ok(out.includes('name="token"'), 'part names survive');
  assert.equal(out.split(`--${b}`).length, body.split(`--${b}`).length, 'boundaries survive');
  // An HTML form field is not a multipart part: nothing after it is masked.
  const html = '<input name="password" type="password">\n<p>a</p>\n\n<p>keep me</p>';
  assert.equal(redactText(html), html);
});

// ── Credential-named fields ──────────────────────────────────────────────────

const SECRET_NAMES = [
  'token',
  'access_token',
  'refresh_token',
  'id_token',
  'auth_token',
  'oauth_token',
  'session_token',
  'csrf_token',
  'csrfmiddlewaretoken',
  'xsrf',
  'x-csrf-token',
  'accessToken',
  'authToken',
  'idToken',
  'sessionToken',
  'api_key',
  'apikey',
  'apiKey',
  'client_secret',
  'secret',
  'password',
  'passwd',
  'private_key',
  'aws_secret_access_key',
  'session_id',
  'sessionId',
  'oauth_verifier',
  'code_verifier',
  'codeVerifier',
  'SAMLResponse',
  'jwt',
];

test('credential-named fields are masked in queries, fragments, forms, JSON and escaped JSON', () => {
  const value = 'FAKEVALUE1234';
  for (const name of SECRET_NAMES) {
    for (const text of [
      `https://example.test/cb?${name}=${value}&state=ok`,
      `https://example.test/cb#${name}=${value}&state=ok`,
      `${name}=${value}&other=1`,
      `{"${name}":"${value}","other":1}`,
      `{"${name}": "${value}"}`,
      JSON.stringify(JSON.stringify({ [name]: value, other: 1 })),
      `${name}: ${value}`,
    ]) {
      const out = text.startsWith('http') ? redactUrl(text) : redactText(text);
      assert.ok(!out.includes(value), `${name} leaked from ${text} -> ${out}`);
    }
  }
  // Masking keeps the name and every other field, and escaped JSON stays parseable.
  const nested = JSON.stringify({ body: JSON.stringify({ id_token: value, keep: 'yes' }) });
  const inner = JSON.parse((JSON.parse(redactText(nested)) as { body: string }).body) as Record<string, string>;
  assert.deepEqual(inner, { id_token: MASK, keep: 'yes' });
});

test('a value that merely starts with a JSON literal is still masked', () => {
  for (const text of ['password=true.blue99', '{"password":"null@home42"}', 'token=false!Secret1', 'password=trueblue']) {
    assert.ok(redactText(text).includes(MASK), text);
  }
});

test('a quoted value is masked whole, and the JSON around it stays parseable', () => {
  const values = [
    'correct horse battery staple',
    ' leading space 123',
    '}brace-first',
    'ab,cdefgh1234',
    "it's my secret",
    'a"b c d',
    'ends-in-backslash\\',
    synthetic('', 5000),
  ];
  for (const password of values) {
    const tail = password.slice(-4);
    for (let depth = 1; depth <= 3; depth++) {
      let text: string = JSON.stringify({ password, keep: 'yes' });
      for (let i = 1; i < depth; i++) text = JSON.stringify(text);
      let out: unknown = redactText(text);
      for (let i = 0; i < depth; i++) out = JSON.parse(out as string);
      // Past depth 1 a value's own escaped quote closes the match early — the
      // JSON stays valid, and only the tail after that quote is left.
      if (depth === 1 || !password.includes('"')) assert.ok(!JSON.stringify(out).includes(tail), `${depth}: ${password}`);
      assert.equal((out as { keep: string }).keep, 'yes');
    }
  }
  assert.ok(!redactText("{'password': 'p@ss w0rd'}").includes('w0rd'));
});

test('credential headers echoed into bodies, logs and errors are masked whole', () => {
  const cookie = 'lang=en; SID=S1234567; HSID=H1234567';
  for (const [text, depth] of [
    [JSON.stringify({ headers: { Cookie: cookie } }), 1],
    [JSON.stringify(JSON.stringify({ headers: { cookie }, keep: 1 })), 2],
    ['{"set-cookie":["SID=S1234567; HSID=H1234567; Path=/"]}', 1],
    ['{"authorization":"Basic SID=S1234567 HSID=H1234567"}', 1],
    [JSON.stringify({ msg: `request failed. Cookie: ${cookie}`, level: 'error' }), 1],
    [JSON.stringify({ raw: `HTTP/1.1 200\r\nSet-Cookie: ${cookie}\r\n\r\nbody` }), 1],
    [`GET / HTTP/1.1\r\nCookie: ${cookie}\r\nX: 1\r\n`, 0],
    [`error: upstream said Proxy-Authorization: Basic SID=S1234567 HSID=H1234567`, 0],
  ] as const) {
    const out = redactText(text);
    assert.ok(!out.includes('S1234567') && !out.includes('H1234567'), out);
    let v: unknown = out;
    for (let i = 0; i < depth; i++) v = JSON.parse(typeof v === 'string' ? v : JSON.stringify(v));
    if (!depth) assert.ok(!text.includes('X: 1') || out.includes('X: 1'), 'the next header line survives');
  }
});

test('pagination cursors, look-alike names and JSON literals are not masked', () => {
  for (const text of [
    '{"hasPassword":true,"id_token":null,"isSecret":false}',
    JSON.stringify(JSON.stringify({ requirePassword: false, push_token: null })),
    '{"emailVerifier":"required-by-policy","saml":"enabled-for-org"}',
    '{"withCredentials":true,"requiresAuthorization":false,"credentials":"include"}',
    '{"acceptCookie":"true","cookie_consent":"granted","session":null}',
    'We need a basic understanding of the Basic Subscription plan',
    'document.cookie=x',
    '{"nextPageToken":"CURSOR123456"}',
    '{"pageToken":"CURSOR123456"}',
    'next_page_token=CURSOR123456',
    '{"nextToken":"CURSOR123456"}',
    '{"syncToken":"CURSOR123456"}',
    '{"paginationToken":"CURSOR123456"}',
    '{"continuationToken":"CURSOR123456"}',
    '{"token_type":"Bearer","expires_in":3600}',
    '{"max_tokens":1024,"input_tokens":55}',
    'country_code=US&postal_code=12345',
    '{"code":"ABCDEFGHIJ","key":"Enter"}',
    'token_v2=not-masked-by-the-generic-rule',
    '{"passwordless":"enabled","secretary":"Jane"}',
  ]) {
    assert.equal(redactText(text), text, `must survive: ${text}`);
  }
});

test('URL-only params (code, sig, signature, session, signed-URL creds) are masked in URLs', () => {
  const value = 'FAKEVALUE1234';
  for (const url of [
    `https://example.test/oauth/cb?code=${value}&state=xyz`,
    `https://example.test/oauth/cb#code=${value}&state=xyz`,
    `https://cdn.example.test/f.png?sig=${value}`,
    `https://cdn.example.test/f.png?Signature=${value}&Key-Pair-Id=K1`,
    `https://bucket.example.test/o?X-Amz-Credential=${value}&X-Amz-Signature=${value}`,
    `https://example.test/p?session=${value}`,
    `/oauth/cb?code=${value}&state=xyz`,
  ]) {
    const out = redactUrl(url);
    assert.ok(!out.includes(value), `leaked from ${url} -> ${out}`);
  }
  assert.equal(redactUrl('https://example.test/x?code=US&lang=en'), 'https://example.test/x?code=US&lang=en');
  assert.equal(redactText('country_code=US&code=US'), 'country_code=US&code=US');
});

test('URL-only params are masked in header values and bodies too, keeping their shape', () => {
  const value = 'FAKEVALUE1234';
  const out = redactHeaders({
    Location: `https://app.test/cb?code=${value}&state=x`,
    Referer: `https://app.test/cb?code=${value}`,
    'Content-Location': `/cb?code=${value}`,
    Link: `<https://x.test/a?X-Amz-Signature=${value}>; rel="next"`,
  });
  assert.ok(!JSON.stringify(out).includes(value), JSON.stringify(out));
  assert.ok(out.Link?.endsWith('>; rel="next"'), out.Link);
  assert.ok(!redactText(`<a href="/o?X-Amz-Credential=x&amp;X-Amz-Signature=${value}">`).includes(value));
  const nested = JSON.stringify({ body: JSON.stringify({ thumb: `https://cdn.test/t.jpg?Policy=p&Signature=${value}`, keep: 'yes' }) });
  const inner = JSON.parse((JSON.parse(redactText(nested)) as { body: string }).body) as Record<string, string>;
  assert.equal(inner.keep, 'yes');
  assert.ok(!inner.thumb?.includes(value));
});

// ── redactUrl: public params, fragments ──────────────────────────────────────

test('redactUrl re-attaches the fragment after the rebuilt query on public-param hosts', () => {
  registerAppRedaction([
    { redaction: { publicParams: [{ hosts: ['fast.com'], params: ['token'] }] } },
  ]);
  assert.equal(
    redactUrl('https://api.fast.com/x?token=P&password=hunter22#frag'),
    'https://api.fast.com/x?token=P&password=%C2%ABredacted%C2%BB#frag',
  );
  const withSecretFragment = redactUrl('https://api.fast.com/x?token=P#access_token=abcd1234');
  assert.ok(withSecretFragment.endsWith(`#access_token=${MASK}`), withSecretFragment);
  assert.ok(withSecretFragment.includes('?token=P'));
  assert.ok(!withSecretFragment.includes('abcd1234'));
  assert.equal(redactUrl('https://api.fast.com/netflix/speedtest'), 'https://api.fast.com/netflix/speedtest');
});

test('redactUrl is idempotent on already-masked URLs', () => {
  for (const url of [
    'https://example.test/cb?access_token=abcd1234&code=FAKEVALUE1234#id_token=abcd1234',
    '/relative/path?password=hunter22',
  ]) {
    const once = redactUrl(url);
    assert.equal(redactUrl(once), once);
  }
});

// ── App patterns are forced global ───────────────────────────────────────────

test('a non-global app pattern still masks every occurrence and is not mutated', () => {
  const p = /tok_[a-z0-9]{8}/;
  registerAppRedaction([{ redaction: { patterns: [p] } }]);
  const out = redactText('tok_aaaaaaaa and tok_bbbbbbbb');
  assert.ok(!out.includes('tok_aaaaaaaa') && !out.includes('tok_bbbbbbbb'), out);
  assert.equal(p.flags, '', "the caller's RegExp is untouched");
});

test('a sticky app pattern masks every occurrence, not only the one at lastIndex', () => {
  registerAppRedaction([{ redaction: { patterns: [/tok_[a-z]{4}/y] } }]);
  const out = redactText('x tok_abcd tok_efgh');
  assert.ok(!out.includes('tok_abcd') && !out.includes('tok_efgh'), out);
});

// ── previewSecret, errors, capture URL fields ────────────────────────────────

test('previewSecret reports short values as presence only', () => {
  assert.equal(previewSecret(''), '');
  assert.equal(previewSecret('abc123'), '«present»');
  assert.equal(previewSecret('x'.repeat(12)), '«present»');
  const long = synthetic('', 40, 'abcdef0123');
  assert.equal(previewSecret(long), `${long.slice(0, 6)}…(+34)`);
  for (let n = 1; n <= 12; n++) {
    const v = 'q'.repeat(n);
    assert.ok(!previewSecret(v).includes(v), `a ${n}-char value must not be revealed`);
  }
});

test('redactedErrorMessage masks credentials in any thrown value', () => {
  assert.ok(!redactedErrorMessage(new Error('token=abcdef123456')).includes('abcdef123456'));
  assert.ok(!redactedErrorMessage('failed: password=hunter22').includes('hunter22'));
  assert.equal(redactedErrorMessage(42), '42');
});

test('redactCaptureUrls masks url, path, tabUrl and classification', () => {
  const secret = 'FAKEVALUE1234';
  const c = {
    id: 'c1',
    url: `https://api.example.test/v1/me?access_token=${secret}`,
    path: `/v1/me?access_token=${secret}&code=${secret}`,
    tabUrl: `https://app.example.test/cb#access_token=${secret}`,
    classification: `GET /cb?code=${secret}`,
    method: 'GET',
  };
  const out = redactCaptureUrls(c);
  assert.ok(!JSON.stringify(out).includes(secret), JSON.stringify(out));
  assert.equal(out.id, 'c1');
  assert.equal(out.method, 'GET');
  assert.equal(c.url.includes(secret), true, 'the input is not mutated');
  const bare = redactCaptureUrls({ url: 'https://a.test/x', path: '/x', tabUrl: null });
  assert.equal(bare.tabUrl, null, 'absent fields stay absent');
  assert.ok(!('classification' in bare));
});

test('adversarial inputs stay linear', () => {
  const MB = 1 << 20;
  const fill = (unit: string, n = MB): string => unit.repeat(Math.ceil(n / unit.length));
  for (const text of [
    `a_token${' '.repeat(100_000)}x`,
    `a_token":${' '.repeat(100_000)}x`,
    `"cookie":${' '.repeat(100_000)}x`,
    `\\"token\\":\\"${'\\'.repeat(100_000)}x`,
    fill('-----BEGIN PRIVATE KEY-----!'),
    fill('-----BEGIN PRIVATE KEY-----!-----EN'),
    fill('-----BEGIN PRIVATE KEY-----\\\\'),
    fill('-----BEGIN PRIVATE KEY-----"'),
    fill('-----BEGIN PRIVATE KEY-----&#12'),
  ]) {
    const t = performance.now();
    redactText(text);
    assert.ok(performance.now() - t < 250, text.slice(0, 40));
  }
});
