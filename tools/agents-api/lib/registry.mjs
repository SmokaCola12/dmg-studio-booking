// Reads agent definitions from .claude/agents/*.md (frontmatter + prompt body).
import fs from 'node:fs';
import path from 'node:path';

export function parseAgent(file) {
  const raw = fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n');
  const m = raw.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!m) return null;
  const meta = {};
  for (const line of m[1].split('\n')) {
    const i = line.indexOf(':');
    if (i > 0) meta[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  }
  if (!meta.name) return null;
  return {
    name: meta.name,
    description: meta.description || '',
    tools: meta.tools ? meta.tools.split(',').map((t) => t.trim()).filter(Boolean) : [],
    model: meta.model || null,
    // Agents whose description starts with DORMANT only run when the caller confirms.
    standby: /^DORMANT/i.test(meta.description || ''),
    prompt: m[2].trim(),
  };
}

export function loadAgents(agentsDir) {
  if (!fs.existsSync(agentsDir)) return [];
  return fs
    .readdirSync(agentsDir)
    .filter((f) => f.endsWith('.md'))
    .map((f) => parseAgent(path.join(agentsDir, f)))
    .filter(Boolean)
    .sort((a, b) => a.name.localeCompare(b.name));
}

export const publicAgent = ({ prompt, ...rest }) => rest;
