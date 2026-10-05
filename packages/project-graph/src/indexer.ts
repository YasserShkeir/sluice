// SPDX-License-Identifier: AGPL-3.0-or-later
import { execFileSync } from 'node:child_process';
import {
  closeSync,
  existsSync,
  lstatSync,
  openSync,
  readFileSync,
  readlinkSync,
  readSync,
  realpathSync,
} from 'node:fs';
import { basename, dirname, extname, isAbsolute, join, posix, resolve } from 'node:path';

import ts from 'typescript';

import { graphEdgeId, type ProjectGraphStore, sha256 } from './store.js';
import type {
  CuratedGraph,
  GraphChunk,
  GraphEdge,
  GraphNode,
  GraphSnapshot,
  GraphStatus,
  RepositoryState,
} from './types.js';

const REPOSITORY_NODE = 'repository:sluice';
const DEFAULT_CURATED_PATH = 'packages/project-graph/knowledge/architecture.json';
const MAX_TEXT_BYTES = 900_000;
const CHUNK_LINES = 90;
const CHUNK_OVERLAP = 12;
const MAX_CHUNKS_PER_FILE = 48;
const TEST_FILE = /\.(?:test|spec)\.[^.]+$/;

const BINARY_EXTENSIONS = new Set([
  '.7z',
  '.avif',
  '.bin',
  '.bmp',
  '.class',
  '.dylib',
  '.eot',
  '.gif',
  '.gz',
  '.ico',
  '.jpeg',
  '.jpg',
  '.mov',
  '.mp3',
  '.mp4',
  '.node',
  '.otf',
  '.pdf',
  '.png',
  '.so',
  '.tar',
  '.ttf',
  '.wasm',
  '.webm',
  '.webp',
  '.woff',
  '.woff2',
  '.zip',
]);

const LANGUAGE_BY_EXTENSION: Record<string, string> = {
  '.css': 'css',
  '.html': 'html',
  '.js': 'javascript',
  '.json': 'json',
  '.jsx': 'javascriptreact',
  '.md': 'markdown',
  '.mjs': 'javascript',
  '.toml': 'toml',
  '.ts': 'typescript',
  '.tsx': 'typescriptreact',
  '.txt': 'text',
  '.yaml': 'yaml',
  '.yml': 'yaml',
};

interface ScannedFile {
  path: string;
  hash: string;
  size: number;
  binary: boolean;
  language?: string;
  content?: string;
  skipReason?: string;
  symlink: boolean;
}

interface ScanResult {
  fingerprint: string;
  files: ScannedFile[];
}

interface PackageInfo {
  id: string;
  name: string;
  root: string;
  path: string;
  description: string;
  dependencies: Record<string, string>;
  devDependencies: Record<string, string>;
  scripts: Record<string, string>;
  bins: Record<string, string>;
}

interface ImportReference {
  specifier: string;
  line: number;
  bindings: Array<{
    local: string;
    imported: string;
    namespace: boolean;
  }>;
}

interface DeclarationReference {
  id: string;
  line: number;
  endLine: number;
}

interface CodeAnalysis {
  path: string;
  sourceFile: ts.SourceFile;
  declarations: DeclarationReference[];
  declarationsByName: Map<string, DeclarationReference>;
  imports: ImportReference[];
}

interface IndexOptions {
  curatedPath?: string | null;
}

function normalizeRepositoryPath(value: string): string {
  return value.split('\\').join('/').replace(/^\.\//, '');
}

function safeRepositoryPath(value: string): boolean {
  if (!value || isAbsolute(value)) return false;
  const normalized = posix.normalize(normalizeRepositoryPath(value));
  return normalized !== '..' && !normalized.startsWith('../') && !normalized.includes('/../');
}

/**
 * Files that must never enter the source graph, even when somebody force-adds
 * them to Git. The graph duplicates searchable text in SQLite, so relying only
 * on .gitignore would turn one accidental `git add -f` into durable secret or
 * captured-traffic retention.
 */
function hardExcludedPath(path: string): boolean {
  const normalized = `/${normalizeRepositoryPath(path).toLowerCase()}`;
  const segments = normalized.split('/').filter(Boolean);
  const name = segments.at(-1) ?? '';
  const extension = extname(name);
  if (
    segments.some((segment) =>
      [
        '.git',
        '.sluice',
        '.vite',
        'node_modules',
        'dist',
        'build',
        'out',
        'coverage',
        'captures',
        'exports',
        'logs',
        'ca',
      ].includes(segment),
    )
  ) {
    return true;
  }
  // docs/* outside docs/public holds private notes and API catalogs rendered
  // from real captured traffic.
  if (segments[0] === 'docs' && segments.length > 1 && segments[1] !== 'public') return true;
  if (name === '.env' || name.startsWith('.env.')) return true;
  if (
    [
      '.envrc',
      '.netrc',
      '.npmrc',
      '.pypirc',
      '.git-credentials',
      '.yarnrc.yml',
      'claude.local.md',
      // Chromium profile stores.
      'cookies',
      'login data',
    ].includes(name)
  ) {
    return true;
  }
  if (/^id_(?:rsa|dsa|ecdsa|ed25519)(?:_sk)?(?:\.|$)/.test(name) && extension !== '.pub') return true;
  const parent = segments.at(-2);
  if (parent === '.docker' && name === 'config.json') return true;
  if (parent === '.claude' && name === 'settings.local.json') return true;
  // Backup copies of databases, keys and state files: graph.sqlite.bak, key.pem.orig.
  if (/\.(?:db|sqlite3?|pem|key|tfstate)\.(?:bak|backup|old|orig|save|tmp|\d+)$/.test(name)) return true;
  // `sluice record --out` and `sluice export --format ndjson` write captured
  // traffic as NDJSON; only checked-in test fixtures may use the format.
  if ((extension === '.ndjson' || extension === '.jsonl') && !segments.includes('fixtures')) {
    return true;
  }
  return [
    '.asc',
    '.cer',
    '.crt',
    '.der',
    '.gpg',
    '.har',
    '.jks',
    '.key',
    '.keystore',
    '.ldb',
    '.log',
    '.p8',
    '.p12',
    '.pfx',
    '.pcap',
    '.pem',
    '.sqlite',
    '.sqlite3',
    '.sqlitedb',
    '.sqlite-journal',
    '.sqlite-shm',
    '.sqlite-wal',
    '.db',
    '.db3',
    '.db-journal',
    '.db-shm',
    '.db-wal',
    '.tfstate',
    '.wal',
    '.shm',
  ].includes(extension);
}

function git(root: string, args: string[]): string {
  return execFileSync('git', args, {
    cwd: root,
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

export function findRepositoryRoot(start = process.cwd()): string {
  const root = git(resolve(start), ['rev-parse', '--show-toplevel']).trim();
  if (!root) throw new Error(`Could not resolve a Git repository from ${start}`);
  return realpathSync(root);
}

export function gitHead(root: string): string | null {
  try {
    return git(root, ['rev-parse', 'HEAD']).trim() || null;
  } catch {
    return null;
  }
}

export function gitWorktreeDirty(root: string): boolean | null {
  try {
    return git(root, ['status', '--porcelain=v1', '--untracked-files=all']).trim().length > 0;
  } catch {
    return null;
  }
}

function gitProjectPaths(root: string): string[] {
  const list = (args: string[]): string[] =>
    git(root, ['ls-files', ...args, '--exclude-standard', '-z'])
      .split('\0')
      .filter(Boolean)
      .map(normalizeRepositoryPath);
  // Git keeps listing a force-added file after it matches an ignore rule. The
  // ignore rule still wins here, so `git add -f` cannot index a private file.
  const ignored = new Set(list(['--cached', '--ignored']));
  return [...new Set(list(['--cached', '--others']))]
    .filter((path) => !ignored.has(path))
    .filter(safeRepositoryPath)
    .filter((path) => !hardExcludedPath(path))
    .sort();
}

function readPrefix(path: string, bytes: number): Buffer {
  const fd = openSync(path, 'r');
  try {
    const buffer = Buffer.alloc(bytes);
    return buffer.subarray(0, readSync(fd, buffer, 0, bytes, 0));
  } finally {
    closeSync(fd);
  }
}

function looksBinary(path: string, value: Buffer): boolean {
  if (BINARY_EXTENSIONS.has(extname(path).toLowerCase())) return true;
  const sample = value.subarray(0, Math.min(value.length, 8_192));
  return sample.includes(0);
}

function languageFor(path: string): string | undefined {
  const byExtension = LANGUAGE_BY_EXTENSION[extname(path).toLowerCase()];
  if (byExtension) return byExtension;
  const name = basename(path);
  if (name === 'LICENSE' || name === 'LICENSING') return 'text';
  if (name === 'Dockerfile') return 'dockerfile';
  return undefined;
}

function shouldSkipChunks(path: string, size: number): string | undefined {
  if (size > MAX_TEXT_BYTES) return `text is larger than ${MAX_TEXT_BYTES} bytes`;
  if (/^(?:pnpm-lock\.yaml|package-lock\.json|yarn\.lock)$/.test(path)) {
    return 'dependency lockfile is represented as metadata, not retrieval chunks';
  }
  if (/\.(?:map|min\.js|min\.css)$/i.test(path)) return 'generated/minified content';
  return undefined;
}

export function scanRepository(rootInput: string): ScanResult {
  const root = realpathSync(resolve(rootInput));
  const files: ScannedFile[] = [];
  const canonicalDirectories = new Map<string, boolean>();
  const canonicalDirectory = (directory: string): boolean => {
    let canonical = canonicalDirectories.get(directory);
    if (canonical === undefined) {
      try {
        canonical = realpathSync(directory) === directory;
      } catch {
        canonical = false;
      }
      canonicalDirectories.set(directory, canonical);
    }
    return canonical;
  };
  for (const path of gitProjectPaths(root)) {
    const absolutePath = resolve(root, path);
    // lstat inspects only the last component. Git still lists index entries
    // that now sit behind a symlinked directory, and reading them would copy
    // files from outside the repository, so any symlinked ancestor is refused.
    if (!canonicalDirectory(dirname(absolutePath))) continue;
    if (!existsSync(absolutePath)) continue;
    const stat = lstatSync(absolutePath);
    if (!stat.isFile() && !stat.isSymbolicLink()) continue;
    const language = languageFor(path);
    if (stat.isSymbolicLink()) {
      const target = readlinkSync(absolutePath);
      files.push({
        path,
        hash: sha256(target),
        size: Buffer.byteLength(target),
        binary: false,
        language,
        skipReason: 'symbolic link; the target is neither followed nor indexed',
        symlink: true,
      });
      continue;
    }
    // Never load an oversized file whole: every status call fingerprints the
    // tree, and a file over 2 GiB makes readFileSync throw. Its identity is its
    // size and mtime; a prefix still decides whether it is binary.
    const tooLarge = stat.size > MAX_TEXT_BYTES;
    const value = tooLarge ? readPrefix(absolutePath, 8_192) : readFileSync(absolutePath);
    const size = tooLarge ? stat.size : value.length;
    const binary = looksBinary(path, value);
    const skipReason = binary ? undefined : shouldSkipChunks(path, size);
    files.push({
      path,
      hash: tooLarge ? sha256(`${size}:${stat.mtimeMs}`) : sha256(value),
      size,
      binary,
      language,
      content: binary || skipReason ? undefined : value.toString('utf8'),
      skipReason,
      symlink: false,
    });
  }
  const fingerprint = sha256(
    files.map((file) => `${file.path}\0${file.hash}\0${file.size}\n`).join(''),
  );
  return { fingerprint, files };
}

function directoryId(path: string): string {
  return `directory:${path || '.'}`;
}

function fileId(path: string): string {
  return `file:${path}`;
}

function packageId(name: string): string {
  return `package:${name}`;
}

function dependencyId(name: string): string {
  return `dependency:${name}`;
}

function externalDependencyNode(name: string): GraphNode {
  return {
    id: dependencyId(name),
    kind: 'external_dependency',
    name,
    description: name.startsWith('node:') ? `Node.js built-in module ${name}` : `External package ${name}`,
    source: 'indexer',
  };
}

function symbolId(path: string, qualifiedName: string, kind: string): string {
  return `symbol:${path}#${encodeURIComponent(qualifiedName)}:${kind}`;
}

function lineOf(source: ts.SourceFile, position: number): number {
  return source.getLineAndCharacterOfPosition(position).line + 1;
}

function hasModifier(node: ts.Node, kind: ts.SyntaxKind): boolean {
  return Boolean(ts.canHaveModifiers(node) && ts.getModifiers(node)?.some((m) => m.kind === kind));
}

/** The prose of a JSDoc block body, without leading asterisks or @tags. */
function jsdocText(body: string): string {
  return body
    .split('\n')
    .map((line) => line.replace(/^\s*\*\s?/, '').trim())
    .filter((line) => line && !line.startsWith('@'))
    .join(' ');
}

function declarationComment(source: ts.SourceFile, node: ts.Node): string {
  const start = node.getStart(source);
  const fullStart = node.getFullStart();
  const prefix = source.text.slice(fullStart, start).trim();
  const block = prefix.match(/\/\*\*([\s\S]*?)\*\/$/);
  if (!block?.[1]) return '';
  return jsdocText(block[1]).slice(0, 700);
}

function declarationKind(node: ts.Node): string | null {
  if (ts.isFunctionDeclaration(node)) return 'function';
  if (ts.isClassDeclaration(node)) return 'class';
  if (ts.isInterfaceDeclaration(node)) return 'interface';
  if (ts.isTypeAliasDeclaration(node)) return 'type';
  if (ts.isEnumDeclaration(node)) return 'enum';
  if (ts.isMethodDeclaration(node) || ts.isMethodSignature(node)) return 'method';
  if (ts.isVariableDeclaration(node)) return 'variable';
  if (ts.isModuleDeclaration(node)) return 'namespace';
  return null;
}

function declaredName(node: ts.Node): string | null {
  if (
    ts.isFunctionDeclaration(node) ||
    ts.isClassDeclaration(node) ||
    ts.isInterfaceDeclaration(node) ||
    ts.isTypeAliasDeclaration(node) ||
    ts.isEnumDeclaration(node) ||
    ts.isModuleDeclaration(node)
  ) {
    return node.name?.getText() ?? null;
  }
  if (ts.isMethodDeclaration(node) || ts.isMethodSignature(node)) return node.name.getText();
  if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)) {
    const statement = node.parent.parent;
    if (
      ts.isVariableStatement(statement) ||
      (node.initializer &&
        (ts.isArrowFunction(node.initializer) || ts.isFunctionExpression(node.initializer)))
    ) {
      return node.name.text;
    }
  }
  return null;
}

/** A modifier on the declaration itself or, for a variable, on its statement. */
function declarationModifier(node: ts.Node, kind: ts.SyntaxKind): boolean {
  if (hasModifier(node, kind)) return true;
  const statement = ts.isVariableDeclaration(node) ? node.parent.parent : undefined;
  return Boolean(statement && ts.isVariableStatement(statement) && hasModifier(statement, kind));
}

function scriptKind(path: string): ts.ScriptKind {
  if (path.endsWith('.tsx')) return ts.ScriptKind.TSX;
  if (path.endsWith('.jsx')) return ts.ScriptKind.JSX;
  if (path.endsWith('.js') || path.endsWith('.mjs')) return ts.ScriptKind.JS;
  return ts.ScriptKind.TS;
}

function analyzeCode(
  path: string,
  content: string,
  addNode: (node: GraphNode) => void,
  addEdge: (edge: GraphEdge) => void,
  addChunk: (chunk: GraphChunk) => void,
): CodeAnalysis {
  const sourceFile = ts.createSourceFile(path, content, ts.ScriptTarget.Latest, true, scriptKind(path));
  const declarations: DeclarationReference[] = [];
  const declarationsByName = new Map<string, DeclarationReference>();

  const visitDeclarations = (node: ts.Node, scope: string[]): void => {
    const kind = declarationKind(node);
    const name = kind ? declaredName(node) : null;
    let nextScope = scope;
    if (kind && name) {
      const qualifiedName = [...scope, name].join('.');
      const line = lineOf(sourceFile, node.getStart(sourceFile));
      const endLine = lineOf(sourceFile, node.getEnd());
      const id = symbolId(path, qualifiedName, kind);
      const exported = declarationModifier(node, ts.SyntaxKind.ExportKeyword);
      const defaultExport = declarationModifier(node, ts.SyntaxKind.DefaultKeyword);
      const reference: DeclarationReference = { id, line, endLine };
      declarations.push(reference);
      if (!declarationsByName.has(name)) declarationsByName.set(name, reference);
      declarationsByName.set(qualifiedName, reference);
      if (defaultExport) declarationsByName.set('default', reference);
      const comment = declarationComment(sourceFile, node);
      addNode({
        id,
        kind: 'symbol',
        name: qualifiedName,
        description: comment || `${kind} ${qualifiedName} declared in ${path}`,
        path,
        startLine: line,
        endLine,
        language: languageFor(path),
        metadata: { declarationKind: kind, exported, defaultExport },
        contentHash: sha256(content.slice(node.getStart(sourceFile), node.getEnd())),
        source: 'indexer',
      });
      addEdge({
        from: fileId(path),
        to: id,
        kind: exported ? 'exports' : 'declares',
        description: `${path} ${exported ? 'exports' : 'declares'} ${qualifiedName}`,
        metadata: { line },
        source: 'indexer',
      });
      const declarationText = content.slice(node.getStart(sourceFile), node.getEnd());
      if (declarationText.length <= 24_000) {
        addChunk({
          id: `chunk:${id}`,
          nodeId: id,
          path,
          title: `${qualifiedName} (${kind}) — ${path}:${line}`,
          text: declarationText,
          startLine: line,
          endLine,
          source: 'indexer',
        });
      }
      if (
        ts.isClassDeclaration(node) ||
        ts.isInterfaceDeclaration(node) ||
        ts.isModuleDeclaration(node) ||
        ts.isFunctionDeclaration(node)
      ) {
        nextScope = [...scope, name];
      }
    }
    ts.forEachChild(node, (child) => visitDeclarations(child, nextScope));
  };
  visitDeclarations(sourceFile, []);

  const imports: ImportReference[] = [];
  const visitImports = (node: ts.Node): void => {
    if (
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
      node.moduleSpecifier &&
      ts.isStringLiteralLike(node.moduleSpecifier)
    ) {
      const bindings: ImportReference['bindings'] = [];
      if (ts.isImportDeclaration(node) && node.importClause) {
        if (node.importClause.name) {
          bindings.push({ local: node.importClause.name.text, imported: 'default', namespace: false });
        }
        const named = node.importClause.namedBindings;
        if (named && ts.isNamespaceImport(named)) {
          bindings.push({ local: named.name.text, imported: '*', namespace: true });
        } else if (named && ts.isNamedImports(named)) {
          for (const element of named.elements) {
            bindings.push({
              local: element.name.text,
              imported: element.propertyName?.text ?? element.name.text,
              namespace: false,
            });
          }
        }
      }
      imports.push({
        specifier: node.moduleSpecifier.text,
        line: lineOf(sourceFile, node.getStart(sourceFile)),
        bindings,
      });
    }
    if (
      ts.isCallExpression(node) &&
      (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
        (ts.isIdentifier(node.expression) && node.expression.text === 'require')) &&
      node.arguments[0] &&
      ts.isStringLiteralLike(node.arguments[0])
    ) {
      imports.push({
        specifier: node.arguments[0].text,
        line: lineOf(sourceFile, node.getStart(sourceFile)),
        bindings: [],
      });
    }
    ts.forEachChild(node, visitImports);
  };
  visitImports(sourceFile);

  return { path, sourceFile, declarations, declarationsByName, imports };
}

function firstMeaningfulDescription(path: string, content: string | undefined, binary: boolean): string {
  if (binary) return `Binary repository asset ${path}`;
  if (!content) return `Repository file ${path}; content is intentionally omitted from retrieval`;
  if (path.endsWith('.md')) {
    const lines = content.split('\n');
    const paragraph: string[] = [];
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#') || trimmed.startsWith('---')) {
        if (paragraph.length > 0) break;
        continue;
      }
      if (trimmed.startsWith('```')) continue;
      paragraph.push(trimmed.replace(/^>\s*/, ''));
      if (paragraph.join(' ').length > 280) break;
    }
    if (paragraph.length > 0) return paragraph.join(' ').slice(0, 400);
  }
  const doc = content.match(/\/\*\*([\s\S]*?)\*\//);
  if (doc?.[1]) {
    const text = jsdocText(doc[1]);
    if (text) return text.slice(0, 400);
  }
  return `${languageFor(path) ?? 'text'} repository file ${path}`;
}

function textChunks(path: string, content: string, nodeId: string): GraphChunk[] {
  const lines = content.split('\n');
  const chunks: GraphChunk[] = [];
  let start = 0;
  while (start < lines.length && chunks.length < MAX_CHUNKS_PER_FILE) {
    const end = Math.min(lines.length, start + CHUNK_LINES);
    const text = lines.slice(start, end).join('\n').trim();
    if (text) {
      chunks.push({
        id: `chunk:${nodeId}:${start + 1}-${end}`,
        nodeId,
        path,
        title: `${path}:${start + 1}-${end}`,
        text,
        startLine: start + 1,
        endLine: end,
        source: 'indexer',
      });
    }
    if (end >= lines.length) break;
    start = Math.max(start + 1, end - CHUNK_OVERLAP);
  }
  return chunks;
}

function readPackages(files: ScannedFile[]): PackageInfo[] {
  const packages: PackageInfo[] = [];
  for (const file of files.filter((entry) => basename(entry.path) === 'package.json')) {
    if (!file.content) continue;
    try {
      const value = JSON.parse(file.content) as Record<string, unknown>;
      const name = typeof value.name === 'string' ? value.name : dirname(file.path) || 'repository';
      const objectStrings = (candidate: unknown): Record<string, string> => {
        if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) return {};
        return Object.fromEntries(
          Object.entries(candidate as Record<string, unknown>).filter(
            (entry): entry is [string, string] => typeof entry[1] === 'string',
          ),
        );
      };
      packages.push({
        id: packageId(name),
        name,
        root: dirname(file.path) === '.' ? '' : dirname(file.path),
        path: file.path,
        description: typeof value.description === 'string' ? value.description : `${name} workspace package`,
        dependencies: objectStrings(value.dependencies),
        devDependencies: objectStrings(value.devDependencies),
        scripts: objectStrings(value.scripts),
        bins: typeof value.bin === 'string' ? { [name]: value.bin } : objectStrings(value.bin),
      });
    } catch {
      // A malformed package manifest remains represented as a file node.
    }
  }
  return packages.sort((a, b) => a.root.localeCompare(b.root));
}

function owningPackage(path: string, packages: PackageInfo[]): PackageInfo | undefined {
  return packages
    .filter((pkg) => !pkg.root || path === pkg.root || path.startsWith(`${pkg.root}/`))
    .sort((a, b) => b.root.length - a.root.length)[0];
}

const IMPORT_SUFFIXES = ['', '.ts', '.tsx', '.js', '.mjs', '.json', '/index.ts', '/index.tsx', '/index.js'];

function importCandidates(fromPath: string, specifier: string): string[] {
  const base = normalizeRepositoryPath(posix.join(posix.dirname(fromPath), specifier));
  const roots = new Set([base, base.replace(/\.(?:m?js|jsx)$/i, '')]);
  return [...roots].flatMap((root) => IMPORT_SUFFIXES.map((suffix) => root + suffix));
}

function resolveImport(
  fromPath: string,
  specifier: string,
  files: Set<string>,
  packagesByName: Map<string, PackageInfo>,
): { file?: string; package?: PackageInfo; external?: string } {
  if (specifier.startsWith('.')) {
    return { file: importCandidates(fromPath, specifier).find((candidate) => files.has(candidate)) };
  }
  const workspace = [...packagesByName.entries()]
    .filter(([name]) => specifier === name || specifier.startsWith(`${name}/`))
    .sort((a, b) => b[0].length - a[0].length)[0];
  if (workspace) {
    const [name, pkg] = workspace;
    const subpath = specifier.slice(name.length).replace(/^\//, '');
    const roots = subpath
      ? [posix.join(pkg.root, subpath), posix.join(pkg.root, 'src', subpath)]
      : [posix.join(pkg.root, 'src/index.ts'), posix.join(pkg.root, 'index.ts')];
    const file = roots
      .flatMap((root) => [root, `${root}.ts`, `${root}.tsx`, `${root}/index.ts`])
      .find((candidate) => files.has(candidate));
    return { package: pkg, file };
  }
  const external = specifier.startsWith('node:')
    ? specifier
    : specifier.startsWith('@')
      ? specifier.split('/').slice(0, 2).join('/')
      : specifier.split('/')[0];
  return { external };
}

function addDerivedConcepts(
  path: string,
  content: string,
  sourceFile: ts.SourceFile | undefined,
  addNode: (node: GraphNode) => void,
  addEdge: (edge: GraphEdge) => void,
): void {
  const concept = (id: string, edgeKind: string, node: Omit<GraphNode, 'id' | 'source'>): void => {
    addNode({ id, ...node, source: 'indexer' });
    addEdge({ from: fileId(path), to: id, kind: edgeKind, source: 'indexer' });
  };

  const tablePattern = /CREATE\s+(?:VIRTUAL\s+)?TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?([A-Za-z_][\w]*)/gi;
  for (const [, name] of content.matchAll(tablePattern)) {
    if (!name) continue;
    concept(`database-table:${name}`, 'defines_table', {
      kind: 'database_table',
      name,
      description: `SQLite table ${name}, declared in ${path}`,
      path,
      metadata: { declaration: path },
    });
  }

  const endpointPattern = /['"`]((?:\/api\/|\/ws\b|\/pty\b)[A-Za-z0-9_./:*-]*)['"`]/g;
  for (const [, endpoint] of content.matchAll(endpointPattern)) {
    if (!endpoint) continue;
    const edgeKind = path.startsWith('apps/webapp/')
      ? 'calls_endpoint'
      : path.includes('packages/runner/src/api.ts') || path.includes('packages/runner/src/server.ts')
        ? 'serves_endpoint'
        : 'references_endpoint';
    concept(`http-endpoint:${endpoint}`, edgeKind, {
      kind: 'http_endpoint',
      name: endpoint,
      description: `Local HTTP/WebSocket endpoint referenced by ${path}`,
      metadata: {},
    });
  }

  if (/\/(?:src\/)?cli\.(?:ts|js|mjs)$/.test(path)) {
    // Dispatch is either a `switch` (`case 'x':`) or a table of `['x', cmdX]` entries.
    const dispatch = /case\s+['"]([a-z][\w-]+)['"]\s*:|\[\s*['"]([a-z][\w-]+)['"]\s*,\s*cmd[A-Z]\w*\s*\]/g;
    for (const [, caseName, tableName] of content.matchAll(dispatch)) {
      const command = caseName ?? tableName;
      if (!command) continue;
      concept(`cli-command:${command}`, 'implements_command', {
        kind: 'cli_command',
        name: command,
        description: `CLI command ${command}, dispatched in ${path}`,
        path,
      });
    }
  }

  if (/protocol\.(?:ts|js)$/.test(path) || path.includes('/protocol/src/')) {
    for (const [, message] of content.matchAll(/z\.literal\(['"]([a-z][\w.-]+)['"]\)/g)) {
      if (!message || !message.includes('.')) continue;
      concept(`websocket-message:${message}`, 'defines_message', {
        kind: 'websocket_message',
        name: message,
        description: `Validated WebSocket message ${message}`,
        path,
      });
    }
  }

  if (sourceFile) {
    const visit = (node: ts.Node): void => {
      if (
        ts.isCallExpression(node) &&
        ts.isPropertyAccessExpression(node.expression) &&
        node.expression.name.text === 'registerTool' &&
        node.arguments[0] &&
        ts.isStringLiteralLike(node.arguments[0])
      ) {
        const tool = node.arguments[0].text;
        concept(`mcp-tool:${tool}`, 'registers_tool', {
          kind: 'mcp_tool',
          name: tool,
          description: `MCP tool ${tool}, registered in ${path}`,
          path,
          startLine: lineOf(sourceFile, node.getStart(sourceFile)),
        });
      }
      ts.forEachChild(node, visit);
    };
    visit(sourceFile);
  }
}

function loadCuratedGraph(root: string, curatedPath: string | null | undefined): CuratedGraph | null {
  if (curatedPath === null) return null;
  const path = resolve(root, curatedPath ?? DEFAULT_CURATED_PATH);
  if (!existsSync(path)) return null;
  const parsed = JSON.parse(readFileSync(path, 'utf8')) as CuratedGraph;
  if (!Number.isInteger(parsed.version) || !Array.isArray(parsed.nodes) || !Array.isArray(parsed.edges)) {
    throw new Error(`Invalid curated graph at ${path}`);
  }
  return parsed;
}

export function buildProjectGraph(rootInput: string, options: IndexOptions = {}): GraphSnapshot {
  const root = realpathSync(resolve(rootInput));
  const scan = scanRepository(root);
  const packages = readPackages(scan.files);
  const packagesByName = new Map(packages.map((pkg) => [pkg.name, pkg]));
  const filePaths = new Set(scan.files.map((file) => file.path));
  const nodes = new Map<string, GraphNode>();
  const edges = new Map<string, GraphEdge>();
  const chunks = new Map<string, GraphChunk>();
  const unresolvedImports: GraphSnapshot['diagnostics']['unresolvedImports'] = [];
  const skippedContent: GraphSnapshot['diagnostics']['skippedContent'] = [];

  const addNode = (node: GraphNode): void => {
    const existing = nodes.get(node.id);
    if (!existing || node.source === 'curated') {
      nodes.set(
        node.id,
        existing
          ? { ...existing, ...node, metadata: { ...existing.metadata, ...node.metadata } }
          : node,
      );
    }
  };
  const addEdge = (edge: GraphEdge): void => {
    const withId = { ...edge, id: edge.id ?? graphEdgeId(edge) };
    edges.set(withId.id, withId);
  };
  const addChunk = (chunk: GraphChunk): void => {
    chunks.set(chunk.id, chunk);
  };

  addNode({
    id: REPOSITORY_NODE,
    kind: 'repository',
    name: 'Sluice',
    description:
      'Local-only SaaS traffic recorder, normalizer, explorer, replay system, dashboard, CLI, and MCP monorepo.',
    path: '.',
    metadata: { root, packageManager: 'pnpm' },
    source: 'indexer',
  });
  addNode({
    id: directoryId('.'),
    kind: 'directory',
    name: '.',
    description: 'Repository root directory',
    path: '.',
    source: 'indexer',
  });
  addEdge({ from: REPOSITORY_NODE, to: directoryId('.'), kind: 'contains', source: 'indexer' });

  for (const pkg of packages) {
    addNode({
      id: pkg.id,
      kind: 'package',
      name: pkg.name,
      description: pkg.description,
      path: pkg.root || '.',
      metadata: { manifest: pkg.path },
      source: 'indexer',
    });
    addEdge({ from: REPOSITORY_NODE, to: pkg.id, kind: 'contains_package', source: 'indexer' });
  }

  const dependencyNames = new Set(
    packages.flatMap((pkg) => [...Object.keys(pkg.dependencies), ...Object.keys(pkg.devDependencies)]),
  );
  for (const name of dependencyNames) {
    if (!packagesByName.has(name)) addNode(externalDependencyNode(name));
  }
  for (const pkg of packages) {
    for (const [dependencies, kind, scope] of [
      [pkg.dependencies, 'depends_on', 'runtime'],
      [pkg.devDependencies, 'dev_depends_on', 'development'],
    ] as const) {
      for (const [name, version] of Object.entries(dependencies)) {
        addEdge({
          from: pkg.id,
          to: packagesByName.get(name)?.id ?? dependencyId(name),
          kind,
          metadata: { version, scope },
          source: 'indexer',
        });
      }
    }
    for (const [name, command] of Object.entries(pkg.scripts)) {
      const id = `script:${pkg.name}:${name}`;
      addNode({
        id,
        kind: 'script',
        name: `${pkg.name}#${name}`,
        description: command,
        path: pkg.path,
        metadata: { command },
        source: 'indexer',
      });
      addEdge({ from: pkg.id, to: id, kind: 'provides_script', source: 'indexer' });
    }
    for (const [name, target] of Object.entries(pkg.bins)) {
      const id = `entrypoint:${pkg.name}:${name}`;
      addNode({
        id,
        kind: 'entrypoint',
        name,
        description: `${pkg.name} executable ${name} resolves to ${target}`,
        path: pkg.path,
        metadata: { target },
        source: 'indexer',
      });
      addEdge({ from: pkg.id, to: id, kind: 'provides_entrypoint', source: 'indexer' });
    }
  }

  const analyses = new Map<string, CodeAnalysis>();
  for (const file of scan.files) {
    const segments = file.path.split('/');
    let parent = '.';
    for (let depth = 1; depth < segments.length; depth += 1) {
      const directory = segments.slice(0, depth).join('/');
      addNode({
        id: directoryId(directory),
        kind: 'directory',
        name: basename(directory),
        description: `Repository directory ${directory}`,
        path: directory,
        source: 'indexer',
      });
      addEdge({
        from: directoryId(parent),
        to: directoryId(directory),
        kind: 'contains',
        source: 'indexer',
      });
      parent = directory;
    }

    const id = fileId(file.path);
    addNode({
      id,
      kind: 'file',
      name: basename(file.path),
      description: firstMeaningfulDescription(file.path, file.content, file.binary),
      path: file.path,
      language: file.language,
      metadata: {
        size: file.size,
        binary: file.binary,
        symlink: file.symlink,
        test: TEST_FILE.test(file.path),
        contentIndexed: Boolean(file.content),
        skipReason: file.skipReason,
      },
      contentHash: file.hash,
      source: 'indexer',
    });
    addEdge({ from: directoryId(parent), to: id, kind: 'contains', source: 'indexer' });
    const pkg = owningPackage(file.path, packages);
    if (pkg) addEdge({ from: pkg.id, to: id, kind: 'contains_file', source: 'indexer' });

    if (file.skipReason) skippedContent.push({ path: file.path, reason: file.skipReason });
    if (!file.content) continue;
    for (const chunk of textChunks(file.path, file.content, id)) addChunk(chunk);
    const analysis = /\.(?:[cm]?js|jsx|ts|tsx)$/.test(file.path)
      ? analyzeCode(file.path, file.content, addNode, addEdge, addChunk)
      : undefined;
    if (analysis) analyses.set(file.path, analysis);
    addDerivedConcepts(file.path, file.content, analysis?.sourceFile, addNode, addEdge);
  }

  for (const analysis of analyses.values()) {
    const importBindings = new Map<
      string,
      { targetPath?: string; imported: string; namespace: boolean }
    >();
    for (const imported of analysis.imports) {
      const resolved = resolveImport(analysis.path, imported.specifier, filePaths, packagesByName);
      const link = (to: string, kind: string, extra: Partial<GraphEdge> = {}): void =>
        addEdge({
          from: fileId(analysis.path),
          to,
          kind,
          metadata: { specifier: imported.specifier, line: imported.line },
          ...extra,
          source: 'indexer',
        });
      if (resolved.file) {
        link(fileId(resolved.file), 'imports');
        if (TEST_FILE.test(analysis.path)) link(fileId(resolved.file), 'tests', { confidence: 0.85 });
      }
      if (resolved.package) link(resolved.package.id, 'imports_package');
      if (resolved.external) {
        addNode(externalDependencyNode(resolved.external));
        link(dependencyId(resolved.external), 'imports_external');
      }
      if (!resolved.file && !resolved.package && !resolved.external) {
        unresolvedImports.push({ path: analysis.path, specifier: imported.specifier });
      }
      for (const binding of imported.bindings) {
        importBindings.set(binding.local, {
          targetPath: resolved.file,
          imported: binding.imported,
          namespace: binding.namespace,
        });
      }
    }

    const scopeStack: string[] = [];
    const visitCalls = (node: ts.Node): void => {
      let pushed = false;
      if (ts.isClassDeclaration(node) && node.name) {
        scopeStack.push(node.name.text);
        pushed = true;
      }
      if (ts.isCallExpression(node)) {
        let target: DeclarationReference | undefined;
        if (ts.isIdentifier(node.expression)) {
          target = analysis.declarationsByName.get(node.expression.text);
          const binding = importBindings.get(node.expression.text);
          if (!target && binding?.targetPath && !binding.namespace) {
            target = analyses.get(binding.targetPath)?.declarationsByName.get(binding.imported);
          }
        } else if (ts.isPropertyAccessExpression(node.expression)) {
          const owner = node.expression.expression;
          const method = node.expression.name.text;
          if (owner.kind === ts.SyntaxKind.ThisKeyword && scopeStack.length > 0) {
            target = analysis.declarationsByName.get(`${scopeStack.at(-1)}.${method}`);
          } else if (ts.isIdentifier(owner)) {
            const binding = importBindings.get(owner.text);
            if (binding?.namespace && binding.targetPath) {
              target = analyses.get(binding.targetPath)?.declarationsByName.get(method);
            }
          }
        }
        if (target) {
          const start = lineOf(analysis.sourceFile, node.getStart(analysis.sourceFile));
          const end = lineOf(analysis.sourceFile, node.getEnd());
          const caller = analysis.declarations
            .filter((decl) => decl.line <= start && decl.endLine >= end)
            .sort((a, b) => a.endLine - a.line - (b.endLine - b.line))[0];
          addEdge({
            from: caller?.id ?? fileId(analysis.path),
            to: target.id,
            kind: 'calls',
            metadata: { line: start },
            confidence: 0.95,
            source: 'indexer',
          });
        }
      }
      ts.forEachChild(node, visitCalls);
      if (pushed) scopeStack.pop();
    };
    visitCalls(analysis.sourceFile);
  }

  const curated = loadCuratedGraph(root, options.curatedPath);
  if (curated) {
    for (const node of curated.nodes) {
      const curatedNode: GraphNode = { ...node, source: 'curated' };
      addNode(curatedNode);
      addChunk({
        id: `chunk:curated:${node.id}`,
        nodeId: node.id,
        path: node.path,
        title: `${node.name} (${node.kind})`,
        text: `${node.name}\n${node.description}`,
        startLine: node.startLine,
        endLine: node.endLine,
        source: 'curated',
      });
    }
    for (const edge of curated.edges) addEdge({ ...edge, source: 'curated' });
  }

  return {
    nodes: [...nodes.values()],
    edges: [...edges.values()],
    chunks: [...chunks.values()],
    fingerprint: scan.fingerprint,
    files: scan.files.map(({ path, hash, size, binary, language }) => ({ path, hash, size, binary, language })),
    diagnostics: { unresolvedImports, skippedContent },
  };
}

export function refreshProjectGraph(
  store: ProjectGraphStore,
  root: string,
  options: IndexOptions = {},
): GraphStatus {
  const indexedHead = gitHead(root);
  const snapshot = buildProjectGraph(root, options);
  store.replaceGenerated(snapshot, { repositoryRoot: root, indexedHead });
  return store.status(repositoryState(root, snapshot.fingerprint));
}

/** Current working-tree facts for store.status/validate; fingerprinting rescans the tree. */
export function repositoryState(
  root: string,
  fingerprint = scanRepository(root).fingerprint,
): RepositoryState {
  return {
    repositoryRoot: root,
    currentFingerprint: fingerprint,
    currentHead: gitHead(root),
    worktreeDirty: gitWorktreeDirty(root),
  };
}

export function defaultProjectGraphPath(root: string): string {
  return join(root, '.sluice', 'project-graph.sqlite');
}
