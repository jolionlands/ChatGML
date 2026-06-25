// test/docs.conformance.test.ts — assert the worked NDJSON block in docs/agent-api.md deep-equals
// the shared fixture, so the documented transcript can never drift from the tested one.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AgentEvent } from '../src/types.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');

function parseNdjson(text: string): AgentEvent[] {
  return text
    .split('\n')
    .filter((l) => l.trim() !== '')
    .map((l) => JSON.parse(l) as AgentEvent);
}

/** Extract the FIRST fenced code block that begins with a `status:ready` NDJSON line. */
function extractTranscriptBlock(md: string): string {
  const blocks = md.split('```');
  for (let i = 1; i < blocks.length; i += 2) {
    const body = blocks[i]!;
    // The worked transcript is the block that contains the ready handshake AND a final answer.
    if (body.includes('"phase":"ready"') && body.includes('"type":"answer"')) {
      return body.replace(/^\n/, '').trimEnd();
    }
  }
  throw new Error('no transcript code block found in agent-api.md');
}

describe('docs/agent-api.md transcript conformance', () => {
  it('the fenced NDJSON block equals the shared fixture', () => {
    const md = readFileSync(path.join(ROOT, 'docs', 'agent-api.md'), 'utf8');
    const fixture = readFileSync(
      path.join(HERE, 'fixtures', 'agent-api-transcript.ndjson'),
      'utf8',
    );
    const docEvents = parseNdjson(extractTranscriptBlock(md));
    const fixtureEvents = parseNdjson(fixture);
    expect(docEvents).toEqual(fixtureEvents);
  });
});
