import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

type Node = { key: string; indent: number; children: Map<string, Node> };

function parseKeys(path: string): Node {
  const root: Node = { key: '', indent: -1, children: new Map() };
  const stack = [root];
  let scalarIndent: number | undefined;
  readFileSync(path, 'utf8')
    .split(/\r?\n/)
    .forEach((line, index) => {
      const indent = line.length - line.trimStart().length;
      if (scalarIndent !== undefined) {
        if (line.trim() === '' || indent > scalarIndent) return;
        scalarIndent = undefined;
      }
      const match = /^( *)([A-Za-z0-9_-]+):(.*)$/.exec(line);
      if (!match || line.trimStart().startsWith('#')) return;
      while (stack.at(-1)!.indent >= indent) stack.pop();
      const parent = stack.at(-1)!;
      const key = match[2]!;
      assert.ok(!parent.children.has(key), `${path}:${index + 1} defines ${key} twice under ${parent.key || 'the root'}`);
      const node: Node = { key, indent, children: new Map() };
      parent.children.set(key, node);
      stack.push(node);
      if (/^\s*[|>][-+]?\s*$/.test(match[3]!)) scalarIndent = indent;
    });
  return root;
}

function namesIn(source: string, call: string): string[] {
  return [...new Set([...readFileSync(source, 'utf8').matchAll(new RegExp(`\\b${call}\\('([a-z-]+)'`, 'g'))].map((match) => match[1]!))].sort();
}

describe('action metadata', () => {
  it('action.yml declares each key once and every input and output src/main.ts uses', () => {
    const root = parseKeys('action.yml');
    const declared = (section: string) => [...(root.children.get(section)?.children.keys() ?? [])].sort();
    assert.deepEqual(declared('inputs'), [...new Set([...namesIn('src/main.ts', 'getInput'), ...namesIn('src/main.ts', 'getBooleanInput')])].sort());
    assert.deepEqual(declared('outputs'), namesIn('src/main.ts', 'setOutput'));
    for (const input of root.children.get('inputs')!.children.values()) {
      assert.ok(input.children.has('description'), `action.yml input ${input.key} has no description`);
    }
    for (const output of root.children.get('outputs')!.children.values()) {
      assert.ok(output.children.has('description'), `action.yml output ${output.key} has no description`);
    }
  });

  it('action.yml has a description the Marketplace accepts, at most 125 characters', () => {
    const description = /^description: (.+)$/m.exec(readFileSync('action.yml', 'utf8'))?.[1]?.trim() ?? '';
    assert.ok(description.length > 0, 'action.yml has no top-level description');
    assert.ok(!description.includes(': '), 'a plain YAML scalar cannot hold a colon followed by a space');
    assert.ok(description.length <= 125, `action.yml description is ${description.length} characters`);
  });

  it('action.yml runs src/main.ts on Node 24', () => {
    const runs = parseKeys('action.yml').children.get('runs')!;
    assert.deepEqual([...runs.children.keys()].sort(), ['main', 'using']);
    assert.match(readFileSync('action.yml', 'utf8'), /^runs:\r?\n {2}using: node24\r?\n {2}main: src\/main\.ts\r?$/m);
  });
});
