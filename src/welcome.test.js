// A aba de exemplos da primeira abertura (src/welcome.md) e o tour dependem de certos trechos dela:
// `npm run test:front` avisa se alguém mexer e quebrar isso.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as B from './blocks.js';
import * as V from './vars.js';

const md = readFileSync(new URL('./welcome.md', import.meta.url), 'utf8');
const a = B.analyze(md);

test('welcome.md: tem blocos de código das 5 linguagens com realce', () => {
  const langs = a.blocks.filter(b => b.code).map(b => (/^\s*`{3,}\s*(\w+)/.exec(a.lines[b.s]) || [])[1]);
  for (const l of ['bash', 'sql', 'json', 'yaml', 'java']) assert.ok(langs.includes(l), 'falta um bloco ' + l);
});

test('welcome.md: o 1º bloco de várias linhas é de código e aparece logo no começo (passo "Copiar um bloco" do tour)', () => {
  const first = a.blocks.find(b => b.e > b.s);
  assert.ok(first.code, 'o primeiro bloco com colchete deveria ser o de código');
  assert.ok(first.s < 20, 'o bloco de código deveria estar nas primeiras linhas');
  assert.equal(B.blockPayload(a.lines, first).text, 'docker compose up -d\ndocker compose logs -f --tail=100');
});

test('welcome.md: tem a linha copiável "git status" (passo "Copiar uma linha" do tour)', () => {
  const i = a.lines.findIndex(l => /^git status/.test(l));
  assert.ok(i >= 0 && B.isCopyableLine(a.lines, a.lineKind, i));
});

test('welcome.md: usa {{host}} e {{porta}}, que os ambientes de exemplo definem', () => {
  const env = [{ key: 'HOST', value: 'dev.exemplo.com.br' }, { key: 'PORTA', value: '8080' }];
  const r = V.resolve(md, env);
  assert.deepEqual(r.missing, []);
  assert.deepEqual(r.used.sort(), ['HOST', 'PORTA']);
});
