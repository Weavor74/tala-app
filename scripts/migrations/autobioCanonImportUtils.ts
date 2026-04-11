import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export type ImportMode = 'dry-run' | 'import';

export interface InspectFileRecord {
  path: string;
  ext: string;
  size: number;
  likelyStructured: boolean;
  likelyLtmf: boolean;
  hasAgeMarker: boolean;
  hasLifeStageMarker: boolean;
}

export interface SourceInspectionReport {
  sourceRoot: string;
  scannedAt: string;
  totalFiles: number;
  extensionCounts: Record<string, number>;
  likelyStructuredCount: number;
  likelyUnstructuredCount: number;
  likelyLtmfCount: number;
  ageMarkerCount: number;
  lifeStageMarkerCount: number;
  recommendedFormat: 'markdown_frontmatter' | 'jsonl' | 'direct_chunks';
  recommendedStrategy: string;
  evaluatedFormats: Array<{
    format: 'markdown_frontmatter' | 'jsonl' | 'direct_chunks';
    supportedByRuntime: boolean;
    reason: string;
  }>;
  includedCandidates: InspectFileRecord[];
  excludedCount: number;
}

export interface NormalizedLtmfEvent {
  eventId: string;
  sourceType: 'ltmf';
  memoryType: 'autobiographical';
  canon: true;
  age: number | null;
  ageSequence: number;
  lifeStage?: string;
  title: string;
  summary: string;
  body: string;
  sourcePath: string;
  sourceHash: string;
}

export interface NormalizeOptions {
  sourceRoot: string;
  includeExtensions?: Set<string>;
}

const DEFAULT_EXTENSIONS = new Set(['.txt', '.md', '.json', '.yaml', '.yml']);
const EXCLUDED_PATH_PARTS = [
  `${path.sep}node-compile-cache${path.sep}`,
  `${path.sep}__pycache__${path.sep}`,
  `${path.sep}.git${path.sep}`,
  `${path.sep}venv${path.sep}`,
  `${path.sep}.venv${path.sep}`,
];

const AGE_CARDINAL: Record<string, number> = {
  one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
  eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17,
  eighteen: 18, nineteen: 19, twenty: 20,
};
const AGE_ORDINAL: Record<string, number> = {
  first: 1, second: 2, third: 3, fourth: 4, fifth: 5, sixth: 6, seventh: 7, eighth: 8, ninth: 9, tenth: 10,
  eleventh: 11, twelfth: 12, thirteenth: 13, fourteenth: 14, fifteenth: 15, sixteenth: 16, seventeenth: 17,
  eighteenth: 18, nineteenth: 19, twentieth: 20,
};

function shouldSkipPath(filePath: string): boolean {
  const n = filePath.toLowerCase();
  return EXCLUDED_PATH_PARTS.some((part) => n.includes(part.toLowerCase()));
}

function normalizeExt(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  return ext || '<none>';
}

export function normalizeExtensionForFile(filePath: string): string {
  return normalizeExt(filePath);
}

function readTextSafe(filePath: string): string {
  try {
    return fs.readFileSync(filePath, 'utf8');
  } catch {
    return fs.readFileSync(filePath).toString('utf8');
  }
}

function looksStructured(ext: string, content: string): boolean {
  if (ext === '.json' || ext === '.yaml' || ext === '.yml') return true;
  if (/^---\s*\n[\s\S]*?\n---\s*/.test(content)) return true;
  if (/^\s*(age|life_stage|memory_type|source_type|canon)\s*:/im.test(content)) return true;
  return false;
}

function hasAgeMarker(content: string, fileName: string): boolean {
  return /(age\s*[:\-\/]\s*\d{1,2}|when\s+you\s+were\s+\d{1,2}|at\s+\d{1,2}\s+years?\s*old|age[_\-\s]?\d{1,2})/i.test(`${fileName}\n${content}`);
}

function hasLifeStageMarker(content: string): boolean {
  return /(life\s*stage|childhood|teen|adulthood|young\s+adult)/i.test(content);
}

export function isLikelyLtmf(filePath: string, content: string): boolean {
  const n = filePath.toLowerCase();
  if (n.includes('ltmf')) return true;
  if (n.includes(`${path.sep}roleplay_md${path.sep}`.toLowerCase())) return true;
  if (n.includes(`${path.sep}roleplay_backup_txt${path.sep}`.toLowerCase())) return true;
  if (/\b(anchor\s*memory|age\s*\/\s*life\s*stage|story\s*outline)\b/i.test(content)) return true;
  return false;
}

function chooseRecommendedFormat(input: {
  extensionCounts: Record<string, number>;
  likelyStructuredCount: number;
  likelyUnstructuredCount: number;
}): {
  recommendedFormat: 'markdown_frontmatter' | 'jsonl' | 'direct_chunks';
  recommendedStrategy: string;
  evaluatedFormats: Array<{
    format: 'markdown_frontmatter' | 'jsonl' | 'direct_chunks';
    supportedByRuntime: boolean;
    reason: string;
  }>;
} {
  const markdownLikeCount = (input.extensionCounts['.md'] ?? 0) + (input.extensionCounts['.txt'] ?? 0);
  const jsonLikeCount = (input.extensionCounts['.json'] ?? 0) + (input.extensionCounts['.yaml'] ?? 0) + (input.extensionCounts['.yml'] ?? 0);

  const evaluatedFormats: Array<{
    format: 'markdown_frontmatter' | 'jsonl' | 'direct_chunks';
    supportedByRuntime: boolean;
    reason: string;
  }> = [
    {
      format: 'markdown_frontmatter',
      supportedByRuntime: true,
      reason:
        'tala-core ingest_file natively parses YAML frontmatter, applies document chunking/embedding, and persists structured metadata consumed by age/canon filters.',
    },
    {
      format: 'jsonl',
      supportedByRuntime: false,
      reason:
        'No dedicated jsonl ingest tool exists in tala-core. jsonl would require runtime ingester changes, which this migration intentionally avoids.',
    },
    {
      format: 'direct_chunks',
      supportedByRuntime: false,
      reason:
        'SimpleVectorStore chunk write path is internal to server.py and not exposed as a safe MCP import contract for one-off migration scripts.',
    },
  ];

  const recommendedFormat: 'markdown_frontmatter' | 'jsonl' | 'direct_chunks' = 'markdown_frontmatter';
  const recommendedStrategy =
    markdownLikeCount >= jsonLikeCount
      ? 'Normalize each event into Markdown with YAML frontmatter and ingest via tala-core ingest_file to preserve existing embedding/indexing and CanonGate-compatible metadata.'
      : 'Even though structured files are present, Markdown frontmatter remains the safest migration format because it uses the existing ingest_file contract without changing runtime ingestion code.';

  return { recommendedFormat, recommendedStrategy, evaluatedFormats };
}

function parseFrontmatter(raw: string): { frontmatter: Record<string, string>; body: string } {
  const m = raw.match(/^---\s*\n([\s\S]*?)\n---\s*\n?/);
  if (!m) return { frontmatter: {}, body: raw };
  const fm = m[1];
  const out: Record<string, string> = {};
  for (const line of fm.split(/\r?\n/)) {
    const mm = line.match(/^\s*([A-Za-z0-9_\-]+)\s*:\s*(.+?)\s*$/);
    if (!mm) continue;
    out[mm[1].toLowerCase()] = mm[2].replace(/^['\"]|['\"]$/g, '');
  }
  return { frontmatter: out, body: raw.slice(m[0].length) };
}

function clampAge(v: number | null): number | null {
  if (v === null) return null;
  if (!Number.isFinite(v)) return null;
  const n = Math.trunc(v);
  if (n < 0 || n > 130) return null;
  return n;
}

function parseAgeToken(token: string | undefined): number | null {
  if (!token) return null;
  const t = token.trim().toLowerCase();
  const num = t.match(/\b(\d{1,2})(st|nd|rd|th)?\b/);
  if (num) return clampAge(Number(num[1]));
  if (t in AGE_CARDINAL) return AGE_CARDINAL[t];
  if (t in AGE_ORDINAL) return AGE_ORDINAL[t];
  return null;
}

function extractAge(filePath: string, frontmatter: Record<string, string>, body: string): number | null {
  const directKeys = ['age', 'age_year'];
  for (const k of directKeys) {
    const age = parseAgeToken(frontmatter[k]);
    if (age !== null) return age;
  }

  const lifeStageAge = parseAgeToken(frontmatter['life_stage'] ?? frontmatter['age_life_stage']);
  if (lifeStageAge !== null) return lifeStageAge;

  const fileName = path.basename(filePath);
  const fromName = fileName.match(/(?:age[_\-\s]?|ltmf-a)(\d{1,2})/i);
  if (fromName) return clampAge(Number(fromName[1]));

  const fromBody = body.match(/age\s*\/\s*life\s*stage\s*:\s*([^\n\r]+)/i);
  if (fromBody) {
    const age = parseAgeToken(fromBody[1]);
    if (age !== null) return age;
  }

  return null;
}

function extractSequence(filePath: string, frontmatter: Record<string, string>): number | null {
  const seqKeys = ['age_sequence', 'sequence', 'order', 'memory_index'];
  for (const k of seqKeys) {
    const val = frontmatter[k];
    if (!val) continue;
    const m = val.match(/\d{1,6}/);
    if (m) return Number(m[0]);
  }

  const fromName = path.basename(filePath).match(/memory[_\-\s]?(\d{1,4})/i);
  if (fromName) return Number(fromName[1]);

  const fromId = (frontmatter['id'] ?? '').match(/a\d{2}-(\d{1,6})/i);
  if (fromId) return Number(fromId[1]);

  return null;
}

function compactWhitespace(text: string): string {
  return text.replace(/\r/g, '').replace(/\n{3,}/g, '\n\n').trim();
}

function deriveTitle(filePath: string, frontmatter: Record<string, string>, body: string): string {
  const title = frontmatter['title'];
  if (title) return title;
  const h1 = body.match(/^\s*#\s+(.+)$/m);
  if (h1) return h1[1].trim();
  const anchor = body.match(/anchor\s*memory\s*:\s*([^\n\r]+)/i);
  if (anchor) return anchor[1].trim();
  return path.basename(filePath, path.extname(filePath)).replace(/[\-_]+/g, ' ').trim();
}

function deriveLifeStage(frontmatter: Record<string, string>, body: string): string | undefined {
  const fromFm = frontmatter['life_stage'] ?? frontmatter['age_life_stage'];
  if (fromFm) return fromFm;
  const m = body.match(/age\s*\/\s*life\s*stage\s*:\s*([^\n\r]+)/i);
  return m?.[1]?.trim();
}

function sha256(text: string): string {
  return crypto.createHash('sha256').update(text).digest('hex');
}

function buildDeterministicEventId(age: number | null, sequence: number, sourceHash: string): string {
  const agePart = age === null ? 'A00' : `A${String(age).padStart(2, '0')}`;
  return `LTMF-${agePart}-${String(sequence).padStart(4, '0')}-${sourceHash.slice(0, 8)}`;
}

function listFilesRecursively(root: string): string[] {
  const out: string[] = [];
  const stack = [root];
  while (stack.length) {
    const dir = stack.pop() as string;
    let entries: fs.Dirent[] = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (shouldSkipPath(full)) continue;
      if (e.isDirectory()) stack.push(full);
      else if (e.isFile()) out.push(full);
    }
  }
  return out.sort((a, b) => a.localeCompare(b));
}

export function inspectSourceTree(sourceRoot: string): SourceInspectionReport {
  const files = listFilesRecursively(sourceRoot);
  const extensionCounts: Record<string, number> = {};
  const includedCandidates: InspectFileRecord[] = [];

  let structured = 0;
  let ltmf = 0;
  let ageMarkers = 0;
  let lifeStageMarkers = 0;

  for (const file of files) {
    const ext = normalizeExt(file);
    extensionCounts[ext] = (extensionCounts[ext] ?? 0) + 1;

    const stats = fs.statSync(file);
    const include = ext === '<none>' || DEFAULT_EXTENSIONS.has(ext);
    if (!include) continue;

    const content = readTextSafe(file);
    const likelyStructured = looksStructured(ext, content);
    const likelyLtmf = isLikelyLtmf(file, content);
    const hasAge = hasAgeMarker(content, path.basename(file));
    const hasLife = hasLifeStageMarker(content);

    if (likelyStructured) structured++;
    if (likelyLtmf) ltmf++;
    if (hasAge) ageMarkers++;
    if (hasLife) lifeStageMarkers++;

    includedCandidates.push({
      path: file,
      ext,
      size: stats.size,
      likelyStructured,
      likelyLtmf,
      hasAgeMarker: hasAge,
      hasLifeStageMarker: hasLife,
    });
  }

  const likelyUnstructuredCount = Math.max(includedCandidates.length - structured, 0);
  const formatDecision = chooseRecommendedFormat({
    extensionCounts,
    likelyStructuredCount: structured,
    likelyUnstructuredCount,
  });

  return {
    sourceRoot,
    scannedAt: new Date().toISOString(),
    totalFiles: files.length,
    extensionCounts,
    likelyStructuredCount: structured,
    likelyUnstructuredCount,
    likelyLtmfCount: ltmf,
    ageMarkerCount: ageMarkers,
    lifeStageMarkerCount: lifeStageMarkers,
    recommendedFormat: formatDecision.recommendedFormat,
    recommendedStrategy: formatDecision.recommendedStrategy,
    evaluatedFormats: formatDecision.evaluatedFormats,
    includedCandidates,
    excludedCount: files.length - includedCandidates.length,
  };
}

export function normalizeLtmfEvents(opts: NormalizeOptions): NormalizedLtmfEvent[] {
  const sourceRoot = opts.sourceRoot;
  const includeExtensions = opts.includeExtensions ?? DEFAULT_EXTENSIONS;
  const files = listFilesRecursively(sourceRoot);

  const provisional: Array<Omit<NormalizedLtmfEvent, 'eventId' | 'ageSequence'> & { _seqHint: number | null }> = [];

  for (const file of files) {
    const ext = normalizeExt(file);
    if (ext !== '<none>' && !includeExtensions.has(ext)) continue;

    const raw = readTextSafe(file);
    if (!isLikelyLtmf(file, raw)) continue;

    const { frontmatter, body } = parseFrontmatter(raw);
    const normalizedBody = compactWhitespace(body || raw);
    if (!normalizedBody) continue;

    const sourceHash = sha256(raw);
    const age = extractAge(file, frontmatter, normalizedBody);
    const sequenceHint = extractSequence(file, frontmatter);
    const title = deriveTitle(file, frontmatter, normalizedBody);
    const lifeStage = deriveLifeStage(frontmatter, normalizedBody);
    const summary = normalizedBody.split(/\n\n/)[0].slice(0, 320).trim();

    provisional.push({
      sourceType: 'ltmf',
      memoryType: 'autobiographical',
      canon: true,
      age,
      lifeStage,
      title,
      summary,
      body: normalizedBody,
      sourcePath: file,
      sourceHash,
      _seqHint: sequenceHint,
    });
  }

  provisional.sort((a, b) => {
    const ageA = a.age ?? 999;
    const ageB = b.age ?? 999;
    if (ageA !== ageB) return ageA - ageB;
    const seqA = a._seqHint ?? 999999;
    const seqB = b._seqHint ?? 999999;
    if (seqA !== seqB) return seqA - seqB;
    const pathCmp = a.sourcePath.localeCompare(b.sourcePath);
    if (pathCmp !== 0) return pathCmp;
    return a.sourceHash.localeCompare(b.sourceHash);
  });

  const perAgeCounter = new Map<number | null, number>();
  const normalized: NormalizedLtmfEvent[] = [];

  for (const item of provisional) {
    const key = item.age;
    const current = perAgeCounter.get(key) ?? 0;
    const seq = item._seqHint ?? current + 1;
    const next = Math.max(current + 1, seq);
    perAgeCounter.set(key, next);

    const eventId = buildDeterministicEventId(item.age, seq, item.sourceHash);

    normalized.push({
      eventId,
      sourceType: item.sourceType,
      memoryType: item.memoryType,
      canon: item.canon,
      age: item.age,
      ageSequence: seq,
      lifeStage: item.lifeStage,
      title: item.title,
      summary: item.summary,
      body: item.body,
      sourcePath: item.sourcePath,
      sourceHash: item.sourceHash,
    });
  }

  return normalized;
}

function yamlSafe(value: string): string {
  const escaped = value.replace(/\r/g, '').replace(/"/g, '\\"');
  return `"${escaped}"`;
}

export function renderNormalizedMarkdown(event: NormalizedLtmfEvent): string {
  const ageValue = event.age === null ? 'null' : String(event.age);
  const lifeStageValue = event.lifeStage ? yamlSafe(event.lifeStage) : 'null';
  const sourcePathValue = yamlSafe(event.sourcePath.replace(/\\/g, '/'));

  return [
    '---',
    `id: ${event.eventId}`,
    'agent: tala',
    'category: roleplay',
    'source_type: ltmf',
    'memory_type: autobiographical',
    'canon: true',
    `age: ${ageValue}`,
    `age_sequence: ${event.ageSequence}`,
    `life_stage: ${lifeStageValue}`,
    `title: ${yamlSafe(event.title)}`,
    `summary: ${yamlSafe(event.summary)}`,
    `source_path: ${sourcePathValue}`,
    `source_hash: ${event.sourceHash}`,
    '---',
    '',
    '## Story Outline',
    event.body,
    '',
  ].join('\n');
}

export function buildVerificationSummary(events: NormalizedLtmfEvent[]): {
  normalizedCount: number;
  ageTaggedCount: number;
  canonAutobioCount: number;
  age17Count: number;
} {
  const ageTaggedCount = events.filter((e) => e.age !== null).length;
  const canonAutobioCount = events.filter((e) => e.canon && e.sourceType === 'ltmf' && e.memoryType === 'autobiographical').length;
  const age17Count = events.filter((e) => e.age === 17).length;
  return {
    normalizedCount: events.length,
    ageTaggedCount,
    canonAutobioCount,
    age17Count,
  };
}
