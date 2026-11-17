// Testes da lógica de blocos e de variáveis: `npm run test:front` (node --test, sem dependências).
import test from 'node:test';
import assert from 'node:assert/strict';
import * as B from './blocks.js';
import * as V from './vars.js';

const run = text => {
  const r = B.analyze(text);
  return { ...r, payload: k => B.blockPayload(r.lines, r.blocks[k]) };
};

test('blocos de texto: linha em branco e --- separam; --- sozinho não vira bloco', () => {
  const r = run('a\nb\n\nc\n---\n---\nd');
  assert.deepEqual(r.blocks.map(b => [b.s, b.e, b.code]), [[0, 1, false], [3, 3, false], [6, 6, false]]);
  assert.deepEqual(r.lineBlock, [0, 0, -1, 1, -1, -1, 2]);
  assert.deepEqual(run('---\n---').blocks, []);
  assert.deepEqual(run('').blocks, []);
});

test('bloco de código fechado: copia só o conteúdo; linha em branco dentro não divide o bloco', () => {
  const r = run('antes\n```bash\nls -la\n\ndf -h\n```\ndepois');
  assert.deepEqual(r.blocks.map(b => [b.s, b.e, b.code]), [[0, 0, false], [1, 5, true], [6, 6, false]]);
  assert.deepEqual(r.lineKind, ['text', 'fence', 'code', 'code', 'code', 'fence', 'text']);
  assert.equal(r.payload(1).text, 'ls -la\n\ndf -h');
  assert.equal(r.payload(1).count, 3);
});

test('bloco de código sem fechamento vai até o fim do texto', () => {
  const r = run('```sql\nselect 1;\nselect 2;');
  assert.deepEqual(r.blocks, [{ s: 0, e: 2, code: true, cs: 1, ce: 2 }]);
  assert.deepEqual(r.lineKind, ['fence', 'code', 'code']);
  assert.equal(r.payload(0).text, 'select 1;\nselect 2;');
});

test('cerca aninhada: só fecha com o mesmo caractere e pelo menos o mesmo tamanho', () => {
  const r = run('````md\n```bash\nls\n```\n~~~\n````\nfora');
  assert.equal(r.blocks.length, 2);
  assert.deepEqual([r.blocks[0].s, r.blocks[0].e, r.blocks[0].code], [0, 5, true]);
  assert.equal(r.payload(0).text, '```bash\nls\n```\n~~~');
  assert.equal(r.lineKind[5], 'fence');
  assert.equal(r.lineKind[6], 'text');
  // ~~~ não é fechado por ```
  const t = run('~~~\nx\n```\ny\n~~~');
  assert.equal(t.payload(0).text, 'x\n```\ny');
});

test('comentários: dentro do código ficam na cópia; fora, não entram no bloco de texto', () => {
  const r = run('# título\ncomando um\n// nota\ncomando dois\n\n```bash\n# comentário de shell\nls\n```');
  assert.equal(r.payload(0).text, 'comando um\ncomando dois');
  assert.equal(r.payload(1).text, '# comentário de shell\nls');
  // bloco só de comentários: copia tudo em vez de nada
  assert.equal(run('# a\n# b').payload(0).text, '# a\n# b');
});

test('linhas copiáveis: cerca, vazia e comentário fora de código não; comentário em código sim', () => {
  const r = run('# c\ntexto\n\n```\n\n# em código\nls\n```');
  const copy = i => B.isCopyableLine(r.lines, r.lineKind, i);
  assert.deepEqual(r.lines.map((_, i) => copy(i)), [false, true, false, false, false, true, true, false]);
});

test('cerca com recuo e texto de informação; bloco de código vazio', () => {
  const r = run('  ```yaml title="x"\n  a: 1\n  ```\n```\n```');
  assert.deepEqual(r.blocks.map(b => [b.s, b.e, b.code]), [[0, 2, true], [3, 4, true]]);
  assert.equal(r.payload(0).text, '  a: 1');
  assert.deepEqual(r.payload(1), { text: '', count: 0 });
});

test('fim de linha CRLF não atrapalha as cercas nem a cópia', () => {
  const r = run('```bash\r\nls\r\n```\r\ntexto\r\n');
  assert.deepEqual(r.blocks.map(b => [b.s, b.e, b.code]), [[0, 2, true], [3, 3, false]]);
  assert.equal(r.payload(0).text, 'ls');
  assert.equal(r.payload(1).text, 'texto');
});

test('variáveis: chave sem diferenciar maiúsculas, com espaços, várias ocorrências', () => {
  const vars = [{ key: 'HOST', value: 'dev.cleandev.com.br' }, { key: 'api.base-url', value: 'https://x/api' }];
  const r = V.resolve('{{host}}/login e {{ Host }} e {{api.base-url}}', vars);
  assert.equal(r.text, 'dev.cleandev.com.br/login e dev.cleandev.com.br e https://x/api');
  assert.deepEqual(r.used, ['HOST', 'api.base-url']);
  assert.deepEqual(r.missing, []);
});

test('variáveis: sem valor ou inexistente não é substituída em silêncio', () => {
  const vars = [{ key: 'HOST', value: 'h' }, { key: 'VAZIA', value: '' }];
  const r = V.resolve('{{HOST}} {{VAZIA}} {{PORT}} {{com espaço}} {{}}', vars);
  assert.equal(r.text, 'h {{VAZIA}} {{PORT}} {{com espaço}} {{}}');
  assert.deepEqual(r.missing, ['VAZIA', 'PORT']);
  assert.equal(V.resolve('{{x}}', []).text, '{{x}}');
  assert.equal(V.resolve('{{x}}', undefined).text, '{{x}}');
});

test('variáveis: valor é literal, não recursivo, e a primeira chave repetida vale', () => {
  const r = V.resolve('{{a}} {{b}}', [{ key: 'a', value: '{{b}} $& $1' }, { key: 'b', value: 'B' }, { key: 'A', value: 'ignorada' }]);
  assert.equal(r.text, '{{b}} $& $1 B');
  assert.equal(V.validKey('ok_1.2-x'), true);
  assert.equal(V.validKey('com espaço'), false);
  assert.equal(V.validKey('a'.repeat(65)), false);
});

test('variáveis: segredo é substituído pelo valor real e o resultado avisa', () => {
  const vars = [{ key: 'HOST', value: 'h' }, { key: 'SENHA', value: 's3gredo', secret: true }];
  assert.deepEqual(V.resolve('{{host}}', vars).secret, false);
  const r = V.resolve('psql -h {{host}} -W {{senha}}', vars);
  assert.equal(r.text, 'psql -h h -W s3gredo');
  assert.equal(r.secret, true);
  // segredo sem valor neste computador (cofre vazio) não é substituído
  assert.deepEqual(V.resolve('{{senha}}', [{ key: 'SENHA', value: '', secret: true }]).missing, ['senha']);
});
