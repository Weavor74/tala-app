/// <reference types="node" />
import * as fs from 'fs';
import * as path from 'path';

const ROOT = path.resolve(__dirname, '../..');
const SHARED_DIR = path.join(ROOT, 'shared');
const SERVICES_DIR = path.join(ROOT, 'electron/services');
const MCP_SERVERS_DIR = path.join(ROOT, 'mcp-servers');
const OUTPUT_CONTRACTS_DIR = path.join(ROOT, 'docs/contracts');
const OUTPUT_SUBSYSTEMS_DIR = path.join(ROOT, 'docs/subsystems');

function ensureDir(dir: string) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

// Simple extractor for TypeScript interfaces and types
function extractTsContracts(filePath: string): string {
  const content = fs.readFileSync(filePath, 'utf-8');
  const relPath = path.relative(ROOT, filePath);
  let md = `# Contract: ${path.basename(filePath)}\n\n`;
  md += `**Source**: [${relPath}](../../${relPath.replace(/\\/g, '/')})\n\n`;

  // Match interfaces
  const interfaceRegex = /export\s+interface\s+(\w+)\s*\{([\s\S]*?)\}/g;
  let match;
  md += '## Interfaces\n\n';
  while ((match = interfaceRegex.exec(content)) !== null) {
    md += `### \`${match[1]}\`\n\`\`\`typescript\ninterface ${match[1]} {${match[2]}}\n\`\`\`\n\n`;
  }

  // Match types
  const typeRegex = /export\s+type\s+(\w+)\s*=([\s\S]*?);/g;
  while ((match = typeRegex.exec(content)) !== null) {
    md += `### \`${match[1]}\`\n\`\`\`typescript\ntype ${match[1]} = ${match[2]};\n\`\`\`\n\n`;
  }

  return md;
}

// Simple extractor for Python MCP tools
function extractMcpTools(serverPath: string): string {
  const serverFile = path.join(serverPath, 'server.py');
  const mcpServerFile = path.join(serverPath, path.basename(serverPath).replace(/-/g, '_'), 'mcp_server.py');
  
  let targetFile = '';
  if (fs.existsSync(serverFile)) targetFile = serverFile;
  else if (fs.existsSync(mcpServerFile)) targetFile = mcpServerFile;
  
  if (!targetFile) return '';

  const content = fs.readFileSync(targetFile, 'utf-8');
  const relPath = path.relative(ROOT, targetFile);
  let md = `# MCP Server: ${path.basename(serverPath)}\n\n`;
  md += `**Source**: [${relPath}](../../${relPath.replace(/\\/g, '/')})\n\n`;

  // Find @mcp.tool() or @tool()
  const toolRegex = /@mcp\.tool\(\)\s+def\s+(\w+)\(([^)]*)\)(?:\s*->\s*([^:]+))?:\s*(?:"""([\s\S]*?)""")?/g;
  let match;
  while ((match = toolRegex.exec(content)) !== null) {
    md += `### Tool: \`${match[1]}\`\n\n`;
    if (match[4]) md += `**Description**: ${match[4].trim()}\n\n`;
    md += `**Arguments**: \`${match[2].trim()}\`\n\n`;
    if (match[3]) md += `**Returns**: \`${match[3].trim()}\`\n\n`;
    md += '---\n\n';
  }

  return md;
}

// Simple extractor for TypeScript classes (Services)
function extractTsServices(filePath: string): string {
  const content = fs.readFileSync(filePath, 'utf-8');
  const relPath = path.relative(ROOT, filePath);
  let md = `# Service: ${path.basename(filePath)}\n\n`;
  md += `**Source**: [${relPath}](../../${relPath.replace(/\\/g, '/')})\n\n`;

  // Extract class name
  const classMatch = content.match(/export\s+class\s+(\w+)/);
  if (!classMatch) return md;
  const className = classMatch[1];
  md += `## Class: \`${className}\`\n\n`;

  // Extract class-level doc comment
  const classDocMatch = content.match(/\/\*\*([\s\S]*?)\*\/\s*export\s+class\s+/);
  if (classDocMatch) {
    md += `## Overview\n${classDocMatch[1].replace(/^\s*\*+/gm, '').trim()}\n\n`;
  }

  // Match methods anchored to the start of the line with 4 spaces (standard class method indentation here)
  // We use a stricter regex to find the start of a method definition
  const lines = content.split('\n');
  md += '### Methods\n\n';
  
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const methodStartMatch = line.match(/^ {4}(?:(?:public|private|protected|async)\s+)+(\w+)\s*\(/);
    
    if (methodStartMatch) {
      const methodName = methodStartMatch[1];
      if (['if', 'for', 'while', 'switch', 'catch', 'constructor', 'require', 'import', 'from'].includes(methodName)) continue;

      // Extract doc comment if it exists above
      let docComment = '';
      let j = i - 1;
      if (j >= 0 && lines[j].trim() === '*/') {
        const commentLines = [];
        while (j >= 0) {
          commentLines.unshift(lines[j]);
          if (lines[j].trim().startsWith('/**')) break;
          j--;
        }
        docComment = commentLines.join('\n');
      }

      // Extract signature (args and return type)
      // We look for the closing ) and then the opening {
      let fullSignature = line.substring(line.indexOf('('));
      let k = i;
      while (k < lines.length && !fullSignature.includes('{')) {
        k++;
        if (k < lines.length) fullSignature += ' ' + lines[k].trim();
      }
      
      const sigMatch = fullSignature.match(/\(([\s\S]*?)\)\s*(?::\s*([^{]+))?\s*\{/);
      if (sigMatch) {
        const args = sigMatch[1];
        const returnType = sigMatch[2];

        md += `#### \`${methodName}\`\n`;
        if (docComment) {
          md += `${docComment.replace(/^\s*\*+/gm, '').replace(/\/\*\*|\*\//g, '').trim()}\n\n`;
        }
        md += `**Arguments**: \`${args.replace(/\s+/g, ' ').trim()}\`\n`;
        if (returnType) md += `**Returns**: \`${returnType.trim()}\`\n`;
        md += '\n---\n';
      }
    }
  }

  return md;
}

console.log('Generating contract documentation...');
ensureDir(OUTPUT_CONTRACTS_DIR);
ensureDir(OUTPUT_SUBSYSTEMS_DIR);

// 1. Shared Contracts
if (fs.existsSync(SHARED_DIR)) {
  const files = fs.readdirSync(SHARED_DIR).filter(f => f.endsWith('.ts'));
  let sharedIndex = '# Shared Contracts Index\n\n';
  for (const file of files) {
    const md = extractTsContracts(path.join(SHARED_DIR, file));
    const outName = file.replace('.ts', '.md');
    fs.writeFileSync(path.join(OUTPUT_CONTRACTS_DIR, outName), md);
    sharedIndex += `- [${file}](./${outName})\n`;
  }
  fs.writeFileSync(path.join(OUTPUT_CONTRACTS_DIR, 'README.md'), sharedIndex);
}

// 2. Electron Services
if (fs.existsSync(SERVICES_DIR)) {
  const files = fs.readdirSync(SERVICES_DIR).filter(f => f.endsWith('.ts'));
  let serviceIndex = '# Backend Services Index\n\n';
  for (const file of files) {
    const md = extractTsServices(path.join(SERVICES_DIR, file));
    const outName = `service-${file.replace('.ts', '.md')}`;
    fs.writeFileSync(path.join(OUTPUT_SUBSYSTEMS_DIR, outName), md);
    serviceIndex += `- [${file}](./${outName})\n`;
  }
  // This index stays in subsystems as it's more about "how the system works" than "pure data contracts"
  fs.writeFileSync(path.join(OUTPUT_SUBSYSTEMS_DIR, 'SERVICES.md'), serviceIndex);
}

// 3. MCP Tools
if (fs.existsSync(MCP_SERVERS_DIR)) {
  const servers = fs.readdirSync(MCP_SERVERS_DIR, { withFileTypes: true }).filter(d => d.isDirectory());
  let mcpIndex = '# MCP Tools Index\n\n';
  for (const server of servers) {
    const md = extractMcpTools(path.join(MCP_SERVERS_DIR, server.name));
    if (md) {
      const outName = `mcp-${server.name}.md`;
      fs.writeFileSync(path.join(OUTPUT_SUBSYSTEMS_DIR, outName), md);
      mcpIndex += `- [${server.name}](./${outName})\n`;
    }
  }
  fs.writeFileSync(path.join(OUTPUT_SUBSYSTEMS_DIR, 'MCP_TOOLS.md'), mcpIndex);
}

console.log('Contract documentation generated.');
