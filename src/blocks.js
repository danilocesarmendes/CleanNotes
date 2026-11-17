/* Lógica de blocos do Markdown, sem DOM: o que é um bloco, o que cada linha é e o que
   entra na cópia. Módulo ES usado pelo editor e pelos testes (`npm run test:front`).

   Bloco de código cercado (``` ou ~~~) = um bloco; copia só o conteúdo. Fora deles,
   linhas em branco ou --- separam blocos de texto, e linhas com # ou // ficam fora da
   cópia do bloco. */
export const isSep = l => { const t = l.trim(); return t === '' || t === '---'; };
export const isComment = l => /^\s*(#|\/\/)/.test(l);

/* text -> { lines, blocks, lineBlock, lineKind }
   blocks:    { s, e, code } ou, para código, { s, e, code: true, cs, ce } (cs..ce = conteúdo)
   lineBlock: índice do bloco de cada linha (-1 se nenhum)
   lineKind:  'text' | 'fence' | 'code' por linha */
export function analyze(text) {
  const lines = text.split('\n');
  const n = lines.length;
  const blocks = [], lineBlock = new Array(n).fill(-1), lineKind = new Array(n).fill('text');
  let s = -1, i = 0;
  const closePara = end => { if (s >= 0) { blocks.push({ s, e: end, code: false }); s = -1; } };
  while (i < n) {
    const m = lines[i].match(/^\s*(`{3,}|~{3,})/);
    if (m) {
      closePara(i - 1);
      const ch = m[1][0], len = m[1].length, start = i;
      lineKind[i] = 'fence';
      let j = i + 1, closed = -1;
      while (j < n) {
        const t = lines[j].trim();
        if (t.length >= len && t === ch.repeat(t.length)) { closed = j; break; }
        lineKind[j] = 'code'; j++;
      }
      const end = closed >= 0 ? closed : n - 1;
      if (closed >= 0) lineKind[closed] = 'fence';
      blocks.push({ s: start, e: end, code: true, cs: start + 1, ce: closed >= 0 ? closed - 1 : n - 1 });
      i = end + 1; continue;
    }
    if (isSep(lines[i])) closePara(i - 1); else if (s < 0) s = i;
    i++;
  }
  closePara(n - 1);
  blocks.forEach((b, k) => { for (let x = b.s; x <= b.e; x++) lineBlock[x] = k; });
  return { lines, blocks, lineBlock, lineKind };
}

/* Texto que o botão de copiar do bloco entrega (e quantas linhas). */
export function blockPayload(lines, b) {
  if (b.code) {
    const parts = b.ce >= b.cs ? lines.slice(b.cs, b.ce + 1) : [];
    return { text: parts.map(l => l.trimEnd()).join('\n'), count: parts.length };
  }
  let parts = lines.slice(b.s, b.e + 1).filter(l => !isComment(l));
  if (!parts.length) parts = lines.slice(b.s, b.e + 1);
  return { text: parts.map(l => l.trimEnd()).join('\n'), count: parts.length };
}

/* A linha ganha botão de copiar? Cercas, linhas vazias e comentários fora de código, não. */
export function isCopyableLine(lines, lineKind, i) {
  const k = lineKind[i];
  if (k === 'fence') return false;
  if (k === 'code') return lines[i].trim() !== '';
  return !isSep(lines[i]) && !isComment(lines[i]);
}
