
import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';

type Dict = Record<string, unknown>;

interface CliOptions {
  root: string;
  dryRun: boolean;
  force: boolean;
  includeTxt: boolean;
  includeExt: Set<string>;
  sample: number;
}

interface FileParts {
  bom: string;
  newline: '\n' | '\r\n';
  hasFrontmatter: boolean;
  frontmatterRaw: string;
  body: string;
}

interface GeneratedFields {
  event_identity: {
    canonical_name: string;
    aliases: string[];
    tags: string[];
    is_named_event: boolean;
    recall_priority: number;
  };
  retrieval: {
    keywords: string[];
    embedding_hint: string;
  };
}

interface Decision {
  status: 'enriched' | 'skipped' | 'failed';
  file: string;
  reason: string;
  changedFields: string[];
  beforeFrontmatter: string;
  afterFrontmatter: string;
}

const DEFAULT_MD_EXTS = new Set(['.md', '.markdown']);
const PRIMARY_SECTION_NAMES = [
  'memory title',
  'story outline',
  'long-term impact hooks',
  'behavioral patterns',
  'emotional tendencies',
  'environmental / situational triggers',
  'canonical identity note',
];
const SECTION_ALIASES = new Map<string, string>([
  ['long term impact hooks', 'long-term impact hooks'],
  ['environmental/situational triggers', 'environmental / situational triggers'],
  ['environmental and situational triggers', 'environmental / situational triggers'],
]);

async function exists(target: string): Promise<boolean> {
  try {
    await fs.access(target);
    return true;
  } catch {
    return false;
  }
}

function shouldSkipPath(filePath: string): boolean {
  const lower = filePath.toLowerCase();
  return lower.includes(`${path.sep}.git${path.sep}`) ||
    lower.includes(`${path.sep}node_modules${path.sep}`) ||
    lower.includes(`${path.sep}node-compile-cache${path.sep}`) ||
    lower.includes(`${path.sep}__pycache__${path.sep}`) ||
    lower.includes(`${path.sep}.venv${path.sep}`) ||
    lower.includes(`${path.sep}venv${path.sep}`);
}

async function listCandidateFiles(root: string, includeExt: Set<string>): Promise<string[]> {
  try {
    const stat = await fs.stat(root);
    if (stat.isFile()) {
      const ext = path.extname(root).toLowerCase();
      return includeExt.has(ext) ? [root] : [];
    }
  } catch {
    // no-op; directory walk below
  }

  const files: string[] = [];
  const stack = [root];

  while (stack.length > 0) {
    const current = stack.pop();
    if (!current) continue;
    let entries: Array<import('node:fs').Dirent> = [];
    try {
      entries = await fs.readdir(current, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries) {
      const fullPath = path.join(current, entry.name);
      if (shouldSkipPath(fullPath)) continue;
      if (entry.isDirectory()) {
        stack.push(fullPath);
        continue;
      }
      if (!entry.isFile()) continue;
      const ext = path.extname(entry.name).toLowerCase();
      if (includeExt.has(ext)) files.push(fullPath);
    }
  }

  files.sort((a, b) => a.localeCompare(b));
  return files;
}

function parseArgs(argv: string[]): CliOptions {
  let root = 'D:\\temp';
  let dryRun = process.env.npm_config_dry_run === 'true';
  let force = process.env.npm_config_force === 'true';
  let includeTxt = false;
  let includeExt = new Set(DEFAULT_MD_EXTS);
  let sample = 3;

  for (let i = 0; i < argv.length; i++) {
    const t = argv[i] ?? '';
    if (t === '--dry-run') { dryRun = true; continue; }
    if (t === '--force') { force = true; continue; }
    if (t === '--include-txt') { includeTxt = true; continue; }
    if (t === '--root' && i + 1 < argv.length) { root = argv[++i] ?? root; continue; }
    if (t.startsWith('--root=')) { root = t.slice(7); continue; }
    if (t === '--sample' && i + 1 < argv.length) {
      const parsed = Number.parseInt(argv[++i] ?? '3', 10);
      if (Number.isFinite(parsed)) sample = parsed;
      continue;
    }
    if (t.startsWith('--sample=')) {
      const parsed = Number.parseInt(t.slice(9), 10);
      if (Number.isFinite(parsed)) sample = parsed;
      continue;
    }
    if (t === '--include-ext' && i + 1 < argv.length) { includeExt = parseExtArg(argv[++i] ?? ''); continue; }
    if (t.startsWith('--include-ext=')) { includeExt = parseExtArg(t.slice(14)); }
  }

  if (includeTxt) includeExt.add('.txt');
  includeExt = new Set(Array.from(includeExt).map((x) => x.toLowerCase()));

  return {
    root: path.resolve(root),
    dryRun,
    force,
    includeTxt,
    includeExt,
    sample: Math.max(0, sample),
  };
}

function parseExtArg(raw: string): Set<string> {
  const out = raw
    .split(',')
    .map((v) => v.trim().toLowerCase())
    .filter(Boolean)
    .map((v) => (v.startsWith('.') ? v : `.${v}`));
  return out.length ? new Set(out) : new Set(DEFAULT_MD_EXTS);
}

function n(text: string): string {
  return text
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/[\u201C\u201D]/g, '"')
    .replace(/[\u2013\u2014]/g, '-')
    .replace(/\u00A0/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function normalizeHeading(raw: string): string {
  const cleaned = n(raw).toLowerCase().replace(/^[#\-\*\s]+/, '').replace(/[:]+$/, '');
  return SECTION_ALIASES.get(cleaned) ?? cleaned;
}

function splitFrontmatter(raw: string): FileParts {
  const bom = raw.startsWith('\uFEFF') ? '\uFEFF' : '';
  const text = bom ? raw.slice(1) : raw;
  const newline: '\n' | '\r\n' = text.includes('\r\n') ? '\r\n' : '\n';
  const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---(\r?\n|$)/);
  if (!m) return { bom, newline, hasFrontmatter: false, frontmatterRaw: '', body: text };
  return { bom, newline, hasFrontmatter: true, frontmatterRaw: m[1] ?? '', body: text.slice(m[0].length) };
}

function parseFrontmatterSafe(raw: string): Dict {
  if (!raw.trim()) return {};
  try {
    const parsed = parseYaml(raw);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? { ...(parsed as Dict) } : {};
  } catch {
    const repaired = raw.replace(/:\[\]/g, ': []').replace(/:\{\}/g, ': {}');
    const parsed = parseYaml(repaired);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? { ...(parsed as Dict) } : {};
  }
}
function parseSections(body: string): Map<string, string[]> {
  const sections = new Map<string, string[]>();
  let current = '__preamble__';
  sections.set(current, []);
  const lines = body.split(/\r?\n/);

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? '';
    const md = line.match(/^\s{0,3}#{1,6}\s+(.+?)\s*#*\s*$/);
    if (md) {
      current = normalizeHeading(md[1] ?? '');
      if (!sections.has(current)) sections.set(current, []);
      continue;
    }

    const plain = normalizeHeading(line);
    if (PRIMARY_SECTION_NAMES.includes(plain)) {
      const prev = n(lines[i - 1] ?? '');
      const next = n(lines[i + 1] ?? '');
      if (!prev || !next || /^[-=]{3,}$/.test(next)) {
        current = plain;
        if (!sections.has(current)) sections.set(current, []);
        if (/^[-=]{3,}$/.test(next)) i += 1;
        continue;
      }
    }

    sections.get(current)?.push(line);
  }

  return sections;
}

function sectionLines(sections: Map<string, string[]>, name: string): string[] {
  return sections.get(normalizeHeading(name)) ?? [];
}

function sectionText(sections: Map<string, string[]>, name: string): string {
  return sectionLines(sections, name).map((line) => line.trim()).join('\n').trim();
}

function sectionItems(sections: Map<string, string[]>, name: string): string[] {
  const out: string[] = [];
  for (const raw of sectionLines(sections, name)) {
    const line = n(raw.replace(/^[-*+]\s+/, '').replace(/^\d+[.)]\s+/, ''));
    if (!line) continue;
    if (/^what happens:/i.test(line) || /^purpose:/i.test(line)) continue;
    if (PRIMARY_SECTION_NAMES.includes(normalizeHeading(line))) continue;
    out.push(line);
  }
  return unique(out);
}

function extractIdentityNote(sections: Map<string, string[]>): string {
  const direct = sectionText(sections, 'canonical identity note');
  if (direct) return direct;

  const style = sectionItems(sections, 'style guarantees');
  const idx = style.findIndex((line) => /canonical identity note/i.test(line));
  if (idx >= 0 && idx + 1 < style.length) {
    return style[idx + 1] ?? '';
  }

  return '';
}

function unique(values: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of values) {
    const key = value.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(value);
  }
  return out;
}

function likelyLtmf(filePath: string, meta: Dict, sections: Map<string, string[]>, body: string): boolean {
  const sourceType = typeof meta.source_type === 'string' ? meta.source_type.toLowerCase() : '';
  if (sourceType === 'ltmf') return true;
  if (filePath.toLowerCase().includes('ltmf')) return true;
  const hasStory = sectionLines(sections, 'story outline').length > 0;
  const hasHooks = sectionLines(sections, 'long-term impact hooks').length > 0;
  if (hasStory && hasHooks) return true;
  const text = n(body).toLowerCase();
  return text.includes('long-term memory file (ltmf)') || (text.includes('age / life stage') && text.includes('theme anchor'));
}

function humanTitle(raw: string): string {
  const cleaned = n(raw)
    .replace(/^tala\s*long\s*term\s*memory\s*file\s*\(ltmf\)\s*/i, '')
    .replace(/^tala_long_term_memory_file_ltmf_/i, '')
    .replace(/^tala[_ ]ltmf[_ ](?:age[_ ]?\d+[_ ]?)?(?:memory[_ ]?\d+[_ ]?)?(?:page[_ ]?\d+[_ ]?)?/i, '')
    .replace(/^ltmf[_ -]a?\d+[_ -]?\d+[_ -]?/i, '')
    .replace(/[_.-]+/g, ' ')
    .replace(/^age[_\s]*\d+[_\s-:—]*/i, '')
    .trim();
  return cleaned
    .split(/\s+/)
    .map((w) => (w ? w.charAt(0).toUpperCase() + w.slice(1).toLowerCase() : w))
    .join(' ');
}

function titleFromFile(filePath: string): string {
  return humanTitle(path.basename(filePath, path.extname(filePath)));
}

function getTitle(filePath: string, meta: Dict, sections: Map<string, string[]>): string {
  const memTitle = sectionItems(sections, 'memory title')[0];
  if (memTitle) return memTitle;
  const fm = typeof meta.title === 'string' ? humanTitle(meta.title) : '';
  if (fm) return fm;
  return titleFromFile(filePath);
}

function concepts(text: string): string[] {
  const lower = text.toLowerCase();
  const out: string[] = [];
  const map: Array<[RegExp, string]> = [
    [/\bscale|vast|large enough|too large\b/, 'scale'],
    [/\banonym|disappear|unseen\b/, 'anonymity'],
    [/\bself[- ]reliance|self reliance|self reliant\b/, 'self-reliance'],
    [/\bstation|dock|ring|corridor|passageway\b/, 'station'],
    [/\bnavigation|route|path|wayfinding\b/, 'navigation'],
    [/\bindependence|independent|on her own|self-supplied|personal continuity\b/, 'independence'],
    [/\bkindness|warmth\b/, 'kindness'],
    [/\bcoldness|dismissive|indifference\b/, 'social-coldness'],
    [/\bgrief|loss|missing\b/, 'grief'],
  ];
  for (const [p, tag] of map) {
    if (p.test(lower)) out.push(tag);
  }
  return unique(out);
}

function fallbackTags(canonical: string, theme: string, body: string): string[] {
  const text = `${canonical} ${theme} ${body}`.toLowerCase();
  const out: string[] = [];
  if (/\bstation|corridor|dock|ring|bay|hatch|lift\b/.test(text)) out.push('station');
  if (/\broute|path|shortcut|detour|navigate\b/.test(text)) out.push('navigation');
  if (/\bgrief|loss|missing\b/.test(text)) out.push('grief');
  if (/\bkind|warmth\b/.test(text)) out.push('kindness');
  if (/\bcold|indifference|dismissive\b/.test(text)) out.push('social-coldness');
  if (/\bcare|reliable|steady|discipline\b/.test(text)) out.push('resilience');
  if (/\bquiet|calm|composure\b/.test(text)) out.push('self-regulation');
  if (/\bmemory|thought|realization|lesson\b/.test(text)) out.push('memory-formation');
  return unique(out);
}
function aliasesFor(canonical: string, story: string, theme: string, tags: string[]): string[] {
  const out: string[] = [canonical];
  const noThe = canonical.replace(/^The\s+/i, '').trim();
  if (noThe && noThe.toLowerCase() !== canonical.toLowerCase()) out.push(noThe);
  const lower = story.toLowerCase();

  if (/large enough|too large|scale/.test(lower) || tags.includes('scale')) {
    out.push('The Station Is Big Enough');
    out.push('When the Station Felt Too Large');
    out.push('The First Scale Realization');
  }
  if (/disappear|disappearing|vanish/.test(lower) || tags.includes('anonymity')) {
    out.push('The Thought of Disappearing');
  }
  if (theme) {
    const t = n(theme);
    if (t.split(/\s+/).length <= 8) out.push(t);
  }

  const cleaned = unique(out)
    .filter((v) => v.length >= 4 && v.length <= 72)
    .filter((v) => !/^what happens:/i.test(v))
    .filter((v) => !PRIMARY_SECTION_NAMES.includes(normalizeHeading(v)));

  if (cleaned.length < 3) {
    const stem = canonical.replace(/^The\s+/i, '').trim();
    cleaned.push(`${stem} Incident`);
    cleaned.push(`When ${canonical}`);
  }

  return unique(cleaned).slice(0, 5);
}

function incidentPhrase(canonical: string, story: string, identityNote: string, theme: string): string {
  const text = `${story}\n${identityNote}\n${theme}`.toLowerCase();
  if (/large enough.*disappear|disappear.*station|too large|vanish|anonymity|awareness of scale/.test(text)) {
    return 'realizes the station is large enough for her to disappear inside it';
  }
  if (/kindness|coldness|indifference|stranger/.test(text)) {
    return 'learns that brief warmth and coldness can rapidly shift her emotional posture';
  }
  if (/echo|footstep|corridor|solitude/.test(text)) {
    return 'discovers that adjusting how she moves can reduce how exposed she feels';
  }
  const first = n(story || identityNote || theme).split(' ').slice(0, 14).join(' ').toLowerCase();
  return first ? `faces ${first}` : `confronts ${canonical.toLowerCase()}`;
}

function consequencePhrase(behavioral: string[], emotional: string[], hooks: string[], body: string): string {
  const text = `${behavioral.join(' ')} ${emotional.join(' ')} ${hooks.join(' ')} ${body}`.toLowerCase();
  if (/independ|self[- ]reliance|self reliant/.test(text)) return 'stays independent and self-reliant in uncertain systems';
  if (/privacy|mask|conceal/.test(text)) return 'manages emotional shifts privately while remaining steady';
  if (/grief|loss|missing/.test(text)) return 'carries grief into disciplined routines that keep her functional';
  const fallback = n(behavioral[0] ?? emotional[0] ?? hooks[0] ?? 'adapts to pressure with quiet control').toLowerCase();
  const plain = fallback.startsWith('she ') ? fallback.replace(/^she\s+/i, '') : fallback;
  return /^(stays|manages|carries|learns|builds|keeps|handles|adapts|maintains|chooses)\b/.test(plain)
    ? plain
    : `adopts ${plain}`;
}

function parseAge(meta: Dict): number | null {
  const raw = meta.age;
  if (typeof raw === 'number' && Number.isFinite(raw)) return raw;
  if (typeof raw === 'string') {
    const m = raw.match(/\d{1,3}/);
    if (m) return Number.parseInt(m[0], 10);
  }
  return null;
}

function buildFields(filePath: string, meta: Dict, sections: Map<string, string[]>, body: string): GeneratedFields {
  const canonical = getTitle(filePath, meta, sections);
  const story = sectionText(sections, 'story outline');
  const hooks = sectionItems(sections, 'long-term impact hooks');
  const behavioral = sectionItems(sections, 'behavioral patterns');
  const emotional = sectionItems(sections, 'emotional tendencies');
  const triggers = sectionItems(sections, 'environmental / situational triggers');
  const identityNote = extractIdentityNote(sections);
  const theme = typeof meta.theme_anchor === 'string' ? n(meta.theme_anchor) : '';

  let tags = unique([
    ...concepts([canonical, story, identityNote, theme, hooks.join(' '), triggers.join(' '), behavioral.join(' '), emotional.join(' '), body].join(' ')),
    'identity-shaping',
    'long-term-memory',
    'adaptation',
  ]).slice(0, 8);

  if (tags.length < 4) {
    tags = unique([
      ...tags,
      ...fallbackTags(canonical, theme, body),
      'station',
      'resilience',
      'memory-formation',
    ]).slice(0, 8);
  }

  const aliases = aliasesFor(canonical, story, theme, tags);
  const incident = incidentPhrase(
    canonical,
    `${story} ${behavioral.join(' ')} ${emotional.join(' ')} ${triggers.join(' ')}`,
    identityNote,
    `${theme} ${hooks.join(' ')}`
  );
  const consequence = consequencePhrase(behavioral, emotional, hooks, body);
  const age = parseAge(meta);
  const stage = typeof meta.life_stage === 'string' ? meta.life_stage.toLowerCase() : '';
  const type = age !== null && age <= 12 ? 'childhood' : age !== null && age <= 19 ? 'adolescent' : /child/.test(stage) ? 'childhood' : 'formative';

  const hint = `A formative ${type} moment where Tala ${incident}, shaping how she ${consequence}.`;

  const keywords = unique([
    canonical.toLowerCase(),
    ...aliases.map((x) => x.toLowerCase()),
    tags.includes('scale') && tags.includes('anonymity') ? 'thought of disappearing in the station' : '',
    tags.includes('scale') ? 'awareness of scale and personal continuity' : '',
    tags.includes('self-reliance') ? 'early self-reliance in a large station' : '',
    tags.includes('anonymity') ? 'fear transformed into quiet resolve' : '',
    n(story).split(' ').slice(0, 10).join(' ').toLowerCase(),
  ].filter(Boolean)).slice(0, 10);

  const priority = Number((0.84 + (tags.includes('scale') || tags.includes('grief') || tags.includes('kindness') ? 0.05 : 0) + (tags.includes('identity-shaping') ? 0.02 : 0)).toFixed(2));

  return {
    event_identity: {
      canonical_name: canonical,
      aliases,
      tags,
      is_named_event: true,
      recall_priority: Math.max(0.5, Math.min(1.0, priority)),
    },
    retrieval: {
      keywords,
      embedding_hint: hint,
    },
  };
}

function validateFields(fields: GeneratedFields): ValidationResult {
  const reasons: string[] = [];
  if (!fields.event_identity.canonical_name.trim()) reasons.push('canonical_name empty');
  if (/^\(.+\)$/.test(fields.event_identity.canonical_name.trim())) reasons.push('canonical_name wrapped in parentheses');
  if (/\bltmf\b|\bpage\s*\d+\b/i.test(fields.event_identity.canonical_name)) reasons.push('canonical_name looks machine-generated');
  if (fields.event_identity.aliases.length < 3 || fields.event_identity.aliases.length > 5) reasons.push('aliases must contain 3-5 items');
  for (const alias of fields.event_identity.aliases) {
    if (alias.split(/\s+/).length > 10) reasons.push(`alias too long: ${alias}`);
    if (/^what happens:/i.test(alias)) reasons.push(`alias fragment: ${alias}`);
  }
  if (fields.event_identity.tags.length < 4 || fields.event_identity.tags.length > 8) reasons.push('tags must contain 4-8 items');
  for (const tag of fields.event_identity.tags) {
    if (tag.split(/\s+/).length > 3) reasons.push(`tag too long: ${tag}`);
  }
  if (!/^A formative .+ where Tala .+, shaping how she .+\.$/.test(fields.retrieval.embedding_hint)) reasons.push('embedding_hint format mismatch');
  if (/(what happens:|purpose:|story outline|long-term impact hooks|##)/i.test(fields.retrieval.embedding_hint)) reasons.push('embedding_hint has section-label fragment');
  return { ok: reasons.length === 0, reasons };
}

function setField(obj: Dict, key: string, value: unknown, force: boolean): boolean {
  const existing = obj[key];
  if (!force && existing !== undefined && existing !== null) {
    if (typeof existing === 'string' && existing.trim()) return false;
    if (typeof existing === 'number' && Number.isFinite(existing)) return false;
    if (typeof existing === 'boolean') return false;
    if (Array.isArray(existing) && existing.length > 0) return false;
  }
  obj[key] = value;
  return true;
}
function applyFields(meta: Dict, generated: GeneratedFields, force: boolean): { nextMeta: Dict; changed: string[] } {
  const nextMeta: Dict = { ...meta };
  const changed: string[] = [];

  const eventIdentity = nextMeta.event_identity && typeof nextMeta.event_identity === 'object' && !Array.isArray(nextMeta.event_identity)
    ? { ...(nextMeta.event_identity as Dict) }
    : {};
  const retrieval = nextMeta.retrieval && typeof nextMeta.retrieval === 'object' && !Array.isArray(nextMeta.retrieval)
    ? { ...(nextMeta.retrieval as Dict) }
    : {};

  if (setField(eventIdentity, 'canonical_name', generated.event_identity.canonical_name, force)) changed.push('event_identity.canonical_name');
  if (setField(eventIdentity, 'aliases', generated.event_identity.aliases, force)) changed.push('event_identity.aliases');
  if (setField(eventIdentity, 'tags', generated.event_identity.tags, force)) changed.push('event_identity.tags');
  if (setField(eventIdentity, 'is_named_event', generated.event_identity.is_named_event, force)) changed.push('event_identity.is_named_event');
  if (setField(eventIdentity, 'recall_priority', generated.event_identity.recall_priority, force)) changed.push('event_identity.recall_priority');

  if (setField(retrieval, 'keywords', generated.retrieval.keywords, force)) changed.push('retrieval.keywords');
  if (setField(retrieval, 'embedding_hint', generated.retrieval.embedding_hint, force)) changed.push('retrieval.embedding_hint');

  if (changed.length) {
    nextMeta.event_identity = eventIdentity;
    nextMeta.retrieval = retrieval;
  }

  return { nextMeta, changed };
}

function renderFrontmatter(meta: Dict, newline: string): string {
  const yaml = stringifyYaml(meta, {
    lineWidth: 0,
    indent: 2,
    blockQuote: false,
    defaultStringType: 'PLAIN',
    defaultKeyType: 'PLAIN',
  }).trimEnd();
  return `---${newline}${yaml}${newline}---${newline}`;
}

function displayPath(filePath: string): string {
  return filePath.replace(/\\/g, '/');
}

async function processFile(filePath: string, options: CliOptions): Promise<Decision> {
  try {
    const raw = await fs.readFile(filePath, 'utf8');
    const parts = splitFrontmatter(raw);
    const before = parts.hasFrontmatter ? parts.frontmatterRaw : '<none>';
    const meta = parts.hasFrontmatter ? parseFrontmatterSafe(parts.frontmatterRaw) : {};
    const sections = parseSections(parts.body);

    if (!likelyLtmf(filePath, meta, sections, parts.body)) {
      return { status: 'skipped', file: filePath, reason: 'not_ltmf', changedFields: [], beforeFrontmatter: before, afterFrontmatter: before };
    }

    const generated = buildFields(filePath, meta, sections, parts.body);
    const validation = validateFields(generated);
    if (!validation.ok) {
      return { status: 'skipped', file: filePath, reason: `validation_failed: ${validation.reasons.join('; ')}`, changedFields: [], beforeFrontmatter: before, afterFrontmatter: before };
    }

    const { nextMeta, changed } = applyFields(meta, generated, options.force);
    if (!changed.length) {
      return { status: 'skipped', file: filePath, reason: options.force ? 'force_no_delta' : 'fields_present', changedFields: [], beforeFrontmatter: before, afterFrontmatter: before };
    }

    const rendered = renderFrontmatter(nextMeta, parts.newline);
    const nextContent = `${parts.bom}${rendered}${parts.body}`;
    if (!options.dryRun) await fs.writeFile(filePath, nextContent, 'utf8');

    return {
      status: 'enriched',
      file: filePath,
      reason: options.dryRun ? 'would_update' : 'updated',
      changedFields: changed,
      beforeFrontmatter: before,
      afterFrontmatter: rendered.replace(/^---\r?\n/, '').replace(/\r?\n---\r?\n?$/, ''),
    };
  } catch (error) {
    return {
      status: 'failed',
      file: filePath,
      reason: error instanceof Error ? error.message : String(error),
      changedFields: [],
      beforeFrontmatter: '<unavailable>',
      afterFrontmatter: '<unavailable>',
    };
  }
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  if (!(await exists(options.root))) throw new Error(`Root directory does not exist: ${options.root}`);

  const files = await listCandidateFiles(options.root, options.includeExt);

  console.log('[ltmf:enrich] Configuration');
  console.log(`- root: ${displayPath(options.root)}`);
  console.log(`- dry_run: ${options.dryRun}`);
  console.log(`- force: ${options.force}`);
  console.log(`- include_txt: ${options.includeTxt}`);
  console.log(`- include_ext: ${Array.from(options.includeExt).join(', ')}`);
  console.log(`- sample: ${options.sample}`);
  console.log(`- candidate_files: ${files.length}`);

  const decisions: Decision[] = [];
  for (const file of files) {
    const decision = await processFile(file, options);
    decisions.push(decision);
    const label = decision.status;
    console.log(`[${label}] ${displayPath(file)} :: ${decision.reason}${decision.changedFields.length ? ` :: ${decision.changedFields.join(', ')}` : ''}`);
  }

  const scanned = decisions.length;
  const enriched = decisions.filter((d) => d.status === 'enriched').length;
  const skipped = decisions.filter((d) => d.status === 'skipped').length;
  const failed = decisions.filter((d) => d.status === 'failed').length;

  console.log('\n[ltmf:enrich] Summary');
  console.log(`- scanned: ${scanned}`);
  console.log(`- enriched: ${enriched}`);
  console.log(`- skipped: ${skipped}`);
  console.log(`- failed: ${failed}`);

  const samples = decisions.filter((d) => d.status === 'enriched').slice(0, options.sample);
  if (samples.length) {
    console.log('\n[ltmf:enrich] Sample Before/After Frontmatter');
    for (const s of samples) {
      console.log(`\nFILE: ${displayPath(s.file)}`);
      console.log('--- BEFORE ---');
      console.log(s.beforeFrontmatter || '<none>');
      console.log('--- AFTER ---');
      console.log(s.afterFrontmatter || '<none>');
    }
  }

  if (failed > 0) process.exitCode = 1;
}

main().catch((error) => {
  console.error(`[ltmf:enrich] failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
