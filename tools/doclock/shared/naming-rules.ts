import ts from 'typescript';
import * as path from 'node:path';
import { NamingContract, Severity, Violation } from './types';

const CODE_EXTENSIONS = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs']);
const SCRIPT_EXTENSIONS = new Set(['.ts', '.tsx', '.js', '.jsx', '.py', '.sh', '.ps1']);
const ROUTE_METHODS = new Set(['get', 'post', 'put', 'patch', 'delete']);
const IPC_METHODS = new Set(['handle', 'on', 'once', 'invoke', 'send']);
const EVENT_METHODS = new Set(['emit', 'publish', 'track', 'recordEvent']);

function compileRegex(pattern?: string): RegExp | null {
  if (!pattern) return null;
  try {
    return new RegExp(pattern);
  } catch {
    return null;
  }
}

function basenameWithoutCompoundExt(relFile: string): string {
  const base = path.posix.basename(relFile);
  if (base.endsWith('.contract.json')) return base.slice(0, -'.contract.json'.length);
  if (base.endsWith('.schema.json')) return base.slice(0, -'.schema.json'.length);
  if (base.endsWith('.config.json')) return base.slice(0, -'.config.json'.length);
  const idx = base.indexOf('.');
  return idx > 0 ? base.slice(0, idx) : base;
}

function splitTokens(name: string): string[] {
  const ascii = name.replace(/[^A-Za-z0-9]+/g, ' ');
  const withCamel = ascii.replace(/([a-z0-9])([A-Z])/g, '$1 $2');
  return withCamel
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map(token => token.toLowerCase());
}

function hasExportModifier(node: ts.Node): boolean {
  const flags = ts.getCombinedModifierFlags(node as ts.Declaration);
  return (flags & ts.ModifierFlags.Export) !== 0;
}

function literalFromExpression(node: ts.Expression): string | null {
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
    return node.text;
  }
  return null;
}

function addViolation(list: Violation[], violation: Violation): void {
  list.push(violation);
}

function validateBannedTerms(
  list: Violation[],
  contract: NamingContract,
  relFile: string,
  name: string,
  rule: string,
  symbol?: string
): void {
  const banned = contract.bannedTerms?.artifactNames ?? [];
  const containsTokens = contract.bannedTerms?.containsTokens ?? [];
  const tokens = splitTokens(name);
  const lowerName = name.toLowerCase();
  const severity = contract.bannedTerms?.severity ?? 'error';

  for (const term of banned) {
    if (tokens.includes(term.toLowerCase())) {
      addViolation(list, {
        file: relFile,
        rule,
        symbol,
        value: name,
        severity,
        message: `Contains banned vague term \"${term}\".`
      });
    }
  }

  for (const token of containsTokens) {
    if (lowerName.includes(token.toLowerCase())) {
      addViolation(list, {
        file: relFile,
        rule,
        symbol,
        value: name,
        severity,
        message: `Contains discouraged token \"${token}\".`
      });
    }
  }
}

function validateFileName(list: Violation[], contract: NamingContract, relFile: string): void {
  const base = path.posix.basename(relFile);
  const ext = path.posix.extname(base);

  const contractRegex = compileRegex(contract.fileNaming?.contracts?.regex);
  const schemaRegex = compileRegex(contract.fileNaming?.schemas?.regex);
  const configRegex = compileRegex(contract.fileNaming?.configs?.regex);
  const docsRegex = compileRegex(contract.fileNaming?.docs?.regex);
  const testRegex = compileRegex(contract.fileNaming?.tests?.regex);
  const scriptsRegex = compileRegex(contract.fileNaming?.scripts?.regex);

  if (base.endsWith('.contract.json') && contractRegex && !contractRegex.test(base)) {
    addViolation(list, {
      file: relFile,
      rule: 'naming/file-pattern',
      severity: contract.fileNaming?.contracts?.severity ?? 'error',
      value: base,
      message: `Contract filename does not match required pattern: ${contract.fileNaming?.contracts?.regex}`
    });
  }

  if (base.endsWith('.schema.json') && schemaRegex && !schemaRegex.test(base)) {
    addViolation(list, {
      file: relFile,
      rule: 'naming/file-pattern',
      severity: contract.fileNaming?.schemas?.severity ?? 'error',
      value: base,
      message: `Schema filename does not match required pattern: ${contract.fileNaming?.schemas?.regex}`
    });
  }

  if (base.endsWith('.config.json') && configRegex && !configRegex.test(base)) {
    addViolation(list, {
      file: relFile,
      rule: 'naming/file-pattern',
      severity: contract.fileNaming?.configs?.severity ?? 'error',
      value: base,
      message: `Config filename does not match required pattern: ${contract.fileNaming?.configs?.regex}`
    });
  }

  if (ext === '.md' && docsRegex && !docsRegex.test(base)) {
    addViolation(list, {
      file: relFile,
      rule: 'naming/file-pattern',
      severity: contract.fileNaming?.docs?.severity ?? 'warn',
      value: base,
      message: `Doc filename does not match preferred pattern: ${contract.fileNaming?.docs?.regex}`
    });
  }

  const isTestFile = /\.(test|spec)\.[A-Za-z0-9]+$/.test(base);
  if (isTestFile && testRegex && !testRegex.test(base)) {
    addViolation(list, {
      file: relFile,
      rule: 'naming/file-pattern',
      severity: contract.fileNaming?.tests?.severity ?? 'error',
      value: base,
      message: `Test filename does not match required pattern: ${contract.fileNaming?.tests?.regex}`
    });
  }

  const inScripts = relFile.startsWith('scripts/') || relFile.startsWith('tools/');
  if (inScripts && SCRIPT_EXTENSIONS.has(ext) && scriptsRegex && !testRegex?.test(base) && !scriptsRegex.test(base)) {
    addViolation(list, {
      file: relFile,
      rule: 'naming/file-pattern',
      severity: contract.fileNaming?.scripts?.severity ?? 'error',
      value: base,
      message: `Script filename does not match required pattern: ${contract.fileNaming?.scripts?.regex}`
    });
  }

  if (CODE_EXTENSIONS.has(ext) && !isTestFile) {
    const tsPatterns = contract.fileNaming?.typescript?.patterns ?? [];
    if (tsPatterns.length > 0) {
      const matching = tsPatterns.some(entry => {
        const rx = compileRegex(entry.regex);
        return rx ? rx.test(base) : false;
      });

      if (!matching) {
        addViolation(list, {
          file: relFile,
          rule: 'naming/file-pattern',
          severity: 'warn',
          value: base,
          message: 'Code filename does not match any configured TypeScript naming pattern.'
        });
      }
    }
  }

  validateBannedTerms(list, contract, relFile, basenameWithoutCompoundExt(relFile), 'naming/banned-term');
}

function validateFunctionName(
  list: Violation[],
  contract: NamingContract,
  relFile: string,
  name: string,
  symbolType: string,
  line?: number,
  column?: number
): void {
  const bannedFns = new Set((contract.bannedTerms?.functionNames ?? []).map(x => x.toLowerCase()));
  if (bannedFns.has(name.toLowerCase())) {
    addViolation(list, {
      file: relFile,
      rule: 'naming/function-banned-name',
      symbol: name,
      value: name,
      severity: 'error',
      line,
      column,
      message: `Function name \"${name}\" is explicitly banned.`
    });
  }

  validateBannedTerms(list, contract, relFile, name, 'naming/banned-term', name);

  const categoryVerbs = Object.values(contract.functionNaming?.verbCategories ?? {}).flat();
  if ((contract.functionNaming?.mustBeVerbFirst ?? false) && categoryVerbs.length > 0) {
    const firstToken = splitTokens(name)[0];
    if (!firstToken || !categoryVerbs.includes(firstToken)) {
      addViolation(list, {
        file: relFile,
        rule: 'naming/function-verb',
        symbol: name,
        value: name,
        severity: 'error',
        line,
        column,
        message: `${symbolType} \"${name}\" is not verb-first with an approved verb.`
      });
    }
  }

  const restricted = new Set((contract.functionNaming?.restrictedVerbs ?? []).map(x => x.toLowerCase()));
  const firstToken = splitTokens(name)[0];
  if (firstToken && restricted.has(firstToken)) {
    addViolation(list, {
      file: relFile,
      rule: 'naming/function-restricted-verb',
      symbol: name,
      value: name,
      severity: contract.functionNaming?.restrictedVerbPolicy?.defaultSeverity ?? 'warn',
      line,
      column,
      message: `${symbolType} \"${name}\" starts with restricted vague verb \"${firstToken}\".`
    });
  }
}

function validateVariableSuffix(
  list: Violation[],
  relFile: string,
  variableName: string,
  line?: number,
  column?: number
): void {
  const checks: Array<{ matcher: RegExp; expected: string; reason: string }> = [
    { matcher: /(?:^|_)id$/i, expected: 'Id', reason: 'Identifier names should end with Id.' },
    { matcher: /(time|timestamp|date)$/i, expected: 'At', reason: 'Timestamp-like names should end with At.' },
    { matcher: /ms$/i, expected: 'Ms', reason: 'Duration names should end with Ms.' },
    { matcher: /path$/i, expected: 'Path', reason: 'Path names should end with Path.' },
    { matcher: /url$/i, expected: 'Url', reason: 'URL names should end with Url.' },
    { matcher: /payload$/i, expected: 'Payload', reason: 'Payload names should end with Payload.' },
    { matcher: /config$/i, expected: 'Config', reason: 'Config names should end with Config.' },
    { matcher: /schema$/i, expected: 'Schema', reason: 'Schema names should end with Schema.' }
  ];

  for (const check of checks) {
    if (!check.matcher.test(variableName)) continue;
    if (!variableName.endsWith(check.expected)) {
      addViolation(list, {
        file: relFile,
        rule: 'naming/variable-suffix',
        symbol: variableName,
        value: variableName,
        severity: 'error',
        line,
        column,
        message: `${check.reason} Found \"${variableName}\".`
      });
    }
  }
}

function validateCodeFile(
  list: Violation[],
  contract: NamingContract,
  relFile: string,
  code: string
): void {
  const source = ts.createSourceFile(relFile, code, ts.ScriptTarget.Latest, true);
  const eventRegex = compileRegex(contract.eventNaming?.regex);
  const ipcRegex = compileRegex(contract.ipcNaming?.regex);
  const apiRegex = compileRegex(contract.apiNaming?.pathRegex);

  for (const stmt of source.statements) {
    if (ts.isClassDeclaration(stmt) && hasExportModifier(stmt) && stmt.name) {
      const { line, character } = source.getLineAndCharacterOfPosition(stmt.name.getStart(source));
      validateBannedTerms(list, contract, relFile, stmt.name.text, 'naming/banned-term', stmt.name.text);
      const allowedSuffixes = new Set((contract.allowedSuffixRoles ?? []).map(x => x.suffix));
      const hasRecognizedSuffix = Array.from(allowedSuffixes).some(suffix => stmt.name!.text.endsWith(suffix));
      if (!hasRecognizedSuffix) {
        addViolation(list, {
          file: relFile,
          rule: 'naming/exported-class-role',
          symbol: stmt.name.text,
          value: stmt.name.text,
          severity: 'warn',
          line: line + 1,
          column: character + 1,
          message: `Exported class \"${stmt.name.text}\" does not end with an approved role suffix.`
        });
      }
    }

    if (ts.isFunctionDeclaration(stmt) && hasExportModifier(stmt) && stmt.name) {
      const { line, character } = source.getLineAndCharacterOfPosition(stmt.name.getStart(source));
      validateFunctionName(list, contract, relFile, stmt.name.text, 'Function', line + 1, character + 1);
    }

    if (ts.isVariableStatement(stmt) && hasExportModifier(stmt)) {
      const isConst = (stmt.declarationList.flags & ts.NodeFlags.Const) !== 0;
      if (!isConst) continue;
      for (const decl of stmt.declarationList.declarations) {
        if (!ts.isIdentifier(decl.name)) continue;
        const symbolName = decl.name.text;
        const { line, character } = source.getLineAndCharacterOfPosition(decl.name.getStart(source));
        validateBannedTerms(list, contract, relFile, symbolName, 'naming/banned-term', symbolName);
        validateVariableSuffix(list, relFile, symbolName, line + 1, character + 1);
      }
    }
  }

  function inspect(node: ts.Node): void {
    if (ts.isCallExpression(node) && node.arguments.length > 0) {
      const first = node.arguments[0];
      const value = literalFromExpression(first);
      if (value) {
        const position = source.getLineAndCharacterOfPosition(first.getStart(source));
        const line = position.line + 1;
        const column = position.character + 1;

        if (ts.isPropertyAccessExpression(node.expression)) {
          const objectName = node.expression.expression.getText(source);
          const methodName = node.expression.name.getText(source);

          if (IPC_METHODS.has(methodName) && (objectName === 'ipcMain' || objectName === 'ipcRenderer' || objectName.endsWith('webContents'))) {
            if (ipcRegex && !ipcRegex.test(value)) {
              addViolation(list, {
                file: relFile,
                rule: 'naming/ipc-pattern',
                symbol: `${objectName}.${methodName}`,
                value,
                severity: contract.ipcNaming?.severity ?? 'error',
                line,
                column,
                message: `IPC channel \"${value}\" does not match required pattern ${contract.ipcNaming?.regex}.`
              });
            }
          }

          if (ROUTE_METHODS.has(methodName) && (objectName === 'app' || objectName === 'router' || objectName.endsWith('Router'))) {
            if (value.startsWith('/') && apiRegex && !apiRegex.test(value)) {
              addViolation(list, {
                file: relFile,
                rule: 'naming/api-route-pattern',
                symbol: `${objectName}.${methodName}`,
                value,
                severity: contract.apiNaming?.severity ?? 'warn',
                line,
                column,
                message: `API route \"${value}\" does not match configured path pattern ${contract.apiNaming?.pathRegex}.`
              });
            }
          }

          if (EVENT_METHODS.has(methodName) && value.includes('.')) {
            if (eventRegex && !eventRegex.test(value)) {
              addViolation(list, {
                file: relFile,
                rule: 'naming/event-pattern',
                symbol: `${objectName}.${methodName}`,
                value,
                severity: contract.eventNaming?.severity ?? 'error',
                line,
                column,
                message: `Event name \"${value}\" does not match event naming pattern ${contract.eventNaming?.regex}.`
              });
            }

            const firstToken = value.split('.')[0];
            const imperative = new Set((contract.eventNaming?.forbiddenImperativePrefixes ?? []).map(x => x.toLowerCase()));
            if (imperative.has(firstToken.toLowerCase())) {
              addViolation(list, {
                file: relFile,
                rule: 'naming/event-command-form',
                symbol: `${objectName}.${methodName}`,
                value,
                severity: contract.eventNaming?.severity ?? 'error',
                line,
                column,
                message: `Event name \"${value}\" starts with forbidden imperative prefix \"${firstToken}\".`
              });
            }
          }
        }
      }
    }

    ts.forEachChild(node, inspect);
  }

  inspect(source);
}

export function collectViolations(
  contract: NamingContract,
  files: string[],
  readFile: (relFile: string) => string | null
): Violation[] {
  const violations: Violation[] = [];

  for (const relFile of files) {
    validateFileName(violations, contract, relFile);

    const ext = path.posix.extname(relFile).toLowerCase();
    if (!CODE_EXTENSIONS.has(ext)) continue;

    const content = readFile(relFile);
    if (content == null) continue;

    validateCodeFile(violations, contract, relFile, content);
  }

  violations.sort((a, b) => {
    const fileCmp = a.file.localeCompare(b.file);
    if (fileCmp !== 0) return fileCmp;
    const ruleCmp = a.rule.localeCompare(b.rule);
    if (ruleCmp !== 0) return ruleCmp;
    const symbolCmp = (a.symbol ?? '').localeCompare(b.symbol ?? '');
    if (symbolCmp !== 0) return symbolCmp;
    return (a.value ?? '').localeCompare(b.value ?? '');
  });

  return violations;
}

export function violationKey(v: Pick<Violation, 'file' | 'rule' | 'symbol' | 'value'>): string {
  return [v.file, v.rule, v.symbol ?? '', v.value ?? ''].join('::');
}
