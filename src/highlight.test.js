// Testes do tokenizador de blocos de código (bash, sql, json, yaml, java): `npm run test:front`.
import test from 'node:test';
import assert from 'node:assert/strict';
import { tokenize, highlight, supports } from './highlight.js';

const kinds = (lang, code) => tokenize(lang, code).map(t => t.cls + ':' + code.slice(t.from, t.to));

test('bash: comentário só depois de espaço, string, variável, flag, palavra-chave', () => {
  assert.deepEqual(kinds('bash', 'ls -la # lista\necho "a $B" $HOME --max 5'), [
    'flag:-la', 'com:# lista', 'str:"a $B"', 'sv:$HOME', 'flag:--max', 'num:5'
  ]);
  assert.deepEqual(kinds('sh', 'curl http://x/#anchor'), []); // # no meio da palavra não é comentário
  assert.deepEqual(kinds('bash', 'if [ -f x ]; then exit; fi'), ['kw:if', 'flag:-f', 'kw:then', 'kw:exit', 'kw:fi']);
});

test('sql: palavras-chave sem diferenciar maiúsculas, strings com aspas dobradas, comentários', () => {
  assert.deepEqual(kinds('sql', "select id from t where n = 'it''s' -- fim"), ['kw:select', 'kw:from', 'kw:where', "str:'it''s'", 'com:-- fim']);
  assert.deepEqual(kinds('postgresql', 'SELECT 1'), ['kw:SELECT', 'num:1']);
  assert.deepEqual(kinds('sql', 'selector'), []); // palavra inteira, não prefixo
});

test('json: chave diferente de valor; números e literais', () => {
  assert.deepEqual(kinds('json', '{"a": "b", "n": -1.5e3, "ok": true, "x": null}'), [
    'key:"a"', 'str:"b"', 'key:"n"', 'num:-1.5e3', 'key:"ok"', 'kw:true', 'key:"x"', 'kw:null'
  ]);
});

test('yaml e java', () => {
  assert.deepEqual(kinds('yml', 'nome: "api"\nativo: true # ok'), ['key:nome', 'str:"api"', 'key:ativo', 'kw:true', 'com:# ok']);
  assert.deepEqual(kinds('java', '@Override\npublic String url() { return "x"; }'), ['ann:@Override', 'kw:public', 'type:String', 'kw:return', 'str:"x"']);
});

test('sem linguagem conhecida: nada é colorido; highlight() escapa HTML e embrulha os trechos', () => {
  assert.equal(supports('text'), false);
  assert.deepEqual(tokenize('text', 'select 1'), []);
  assert.equal(highlight('text', '<b>&</b>'), '&lt;b&gt;&amp;&lt;/b&gt;');
  assert.equal(highlight('json', '{"a": 1}'), '{<span class="tk-key">&quot;a&quot;</span>: <span class="tk-num">1</span>}');
  assert.equal(highlight('bash', 'echo "<x>"'), 'echo <span class="tk-str">&quot;&lt;x&gt;&quot;</span>');
});

test('posições dos trechos batem com o texto (serve ao editor, que decora por posição)', () => {
  const code = 'SELECT "x" FROM t;\n-- c';
  for (const t of tokenize('sql', code)) assert.ok(t.from >= 0 && t.to <= code.length && t.to > t.from);
  const toks = tokenize('sql', code);
  assert.deepEqual(toks.map(t => [t.from, t.to]), [...toks.map(t => [t.from, t.to])].sort((a, b) => a[0] - b[0]));
});
