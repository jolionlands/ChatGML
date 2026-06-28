// test/vscode/client-wire.test.ts — proves the VS Code extension's NdjsonClient emits the SAME v2
// wire shapes as the GMEdit plugin client (plugin/client.js). The extension's ndjson-client.ts is a
// typed TS re-implementation, not a copy of the CJS plugin client, so this test guards against
// drift. It requires the BUILT vscode/dist/ndjson-client.js — if the build isn't present (e.g. a
// bare core checkout without the extension), it skips rather than fails.
import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';
import path from 'node:path';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const CLIENT_JS = path.join(HERE, '../../vscode/dist/ndjson-client.js');

const built = existsSync(CLIENT_JS);
const suite = describe;
const itIf = built ? it : it.skip;

suite('vscode NdjsonClient wire shapes (built artifact)', () => {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { NdjsonClient } = require(CLIENT_JS) as {
    NdjsonClient: new (opts: { onEvent?: (e: unknown) => void }) => {
      send(cmd: unknown): boolean;
      sendUser(text: string, context?: unknown): boolean;
      sendResume(messages: unknown[]): boolean;
      sendClear(): boolean;
      approve(id: string): boolean;
      reject(id: string): boolean;
      reindex(): boolean;
    };
  };

  itIf('sendUser/sendResume/sendClear/approve/reject/reindex produce the v2 wire shapes', () => {
    void NdjsonClient; // satisfy unused warning under skip
    const sent: unknown[] = [];
    const client = new NdjsonClient({ onEvent: () => {} });
    (client as unknown as { send(cmd: unknown): boolean }).send = (cmd: unknown) => {
      sent.push(cmd);
      return true;
    };
    client.sendUser('hi');
    client.sendUser('hi', { openFile: 'a.gml', cursorLine: 3 });
    client.sendResume([{ role: 'user', content: 'q' }]);
    client.sendClear();
    client.approve('e1');
    client.reject('e2');
    client.reindex();
    expect(sent).toEqual([
      { type: 'user', text: 'hi' },
      { type: 'user', text: 'hi', context: { openFile: 'a.gml', cursorLine: 3 } },
      { type: 'resume', messages: [{ role: 'user', content: 'q' }] },
      { type: 'clear' },
      { type: 'approve', id: 'e1' },
      { type: 'reject', id: 'e2' },
      { type: 'reindex' },
    ]);
  });
});

if (!built) {
  // eslint-disable-next-line no-console
  console.warn('[vscode client-wire.test] skipped: vscode/dist/ndjson-client.js not built');
}
