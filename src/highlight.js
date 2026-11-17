import { esc } from './util.js';

/* ---------- Realce de sintaxe (blocos de código do preview) ----------
   Um tokenizador pequeno por linguagem, sem dependência: regras tentadas em ordem
   a cada posição. bash, sql, json, yaml e java. */
const rule = (cls, src, flags, guard) => ({ cls, re: new RegExp(src, 'y' + (flags || '')), guard });
const afterSpace = (c, i) => i === 0 || /\s/.test(c[i - 1]);
const words = list => '\\b(?:' + list + ')\\b';
const LANGS = {
  bash: [
    rule('com', '#[^\\n]*', '', afterSpace),
    rule('str', '"(?:\\\\.|[^"\\\\\\n])*"?'),
    rule('str', "'[^'\\n]*'?"),
    rule('sv', '\\$\\{[^}\\n]*\\}|\\$[A-Za-z_]\\w*|\\$[0-9@#?*!$]'),
    rule('flag', '--?[A-Za-z][\\w-]*', '', afterSpace),
    rule('kw', words('if|then|else|elif|fi|for|while|until|do|done|case|esac|function|in|return|export|local|exit|sudo|source')),
    rule('num', '\\b\\d+\\b')
  ],
  sql: [
    rule('com', '--[^\\n]*|/\\*[\\s\\S]*?(?:\\*/|$)'),
    rule('str', "'(?:''|[^'])*'?"),
    rule('num', '\\b\\d+(?:\\.\\d+)?\\b'),
    rule('kw', words('select|from|where|and|or|not|insert|into|values|update|set|delete|join|left|right|inner|outer|full|cross|on|group|by|order|limit|offset|having|as|create|table|alter|add|column|drop|index|distinct|union|all|null|is|in|like|ilike|between|exists|case|when|then|else|end|primary|key|foreign|references|default|desc|asc|count|sum|avg|min|max|interval|now|begin|commit|rollback|with|returning|true|false'), 'i')
  ],
  json: [
    rule('key', '"(?:\\\\.|[^"\\\\\\n])*"(?=\\s*:)'),
    rule('str', '"(?:\\\\.|[^"\\\\\\n])*"?'),
    rule('num', '-?\\d+(?:\\.\\d+)?(?:[eE][+-]?\\d+)?'),
    rule('kw', words('true|false|null'))
  ],
  yaml: [
    rule('com', '#[^\\n]*', '', afterSpace),
    rule('key', '[A-Za-z0-9_./-]+(?=[ \\t]*:(?:\\s|$))'),
    rule('key', '"[^"\\n]*"(?=[ \\t]*:(?:\\s|$))'),
    rule('str', '"(?:\\\\.|[^"\\\\\\n])*"?'),
    rule('str', "'[^'\\n]*'?"),
    rule('sv', '[&*][\\w-]+'),
    rule('num', '-?\\b\\d+(?:\\.\\d+)?\\b'),
    rule('kw', words('true|false|null|yes|no'), 'i')
  ],
  java: [
    rule('com', '//[^\\n]*|/\\*[\\s\\S]*?(?:\\*/|$)'),
    rule('str', '"(?:\\\\.|[^"\\\\\\n])*"?'),
    rule('str', "'(?:\\\\.|[^'\\\\\\n])'?"),
    rule('ann', '@[A-Za-z_]\\w*'),
    rule('kw', words('abstract|assert|boolean|break|byte|case|catch|char|class|continue|default|do|double|else|enum|extends|final|finally|float|for|if|implements|import|instanceof|int|interface|long|new|package|private|protected|public|return|short|static|super|switch|synchronized|this|throw|throws|try|var|void|volatile|while|record|true|false|null')),
    rule('num', '\\b\\d+(?:\\.\\d+)?[LlFfDd]?\\b'),
    rule('type', '\\b[A-Z][A-Za-z0-9_]*\\b')
  ]
};
const LANG_ALIAS = { sh: 'bash', shell: 'bash', zsh: 'bash', console: 'bash', psql: 'sql', postgresql: 'sql', mysql: 'sql', jsonc: 'json', yml: 'yaml' };

/* Língua do bloco -> regras (ou undefined, se não há realce para ela). */
const rulesFor = lang => LANGS[LANG_ALIAS[lang] || lang];
export const supports = lang => !!rulesFor(lang);

/* code -> [{ from, to, cls }] (posições no texto), só com os trechos que ganham cor. */
export function tokenize(lang, code) {
  const rules = rulesFor(lang);
  const out = [];
  if (!rules) return out;
  let i = 0;
  while (i < code.length) {
    let hit = null;
    for (const r of rules) {
      if (r.guard && !r.guard(code, i)) continue;
      r.re.lastIndex = i;
      const m = r.re.exec(code);
      if (m && m[0].length) { hit = { from: i, to: i + m[0].length, cls: r.cls }; break; }
    }
    if (hit) { out.push(hit); i = hit.to; } else i++;
  }
  return out;
}

/* code -> HTML com <span class="tk-..."> (usado pelo preview). */
export function highlight(lang, code) {
  if (!supports(lang)) return esc(code);
  let html = '', at = 0;
  for (const t of tokenize(lang, code)) {
    html += esc(code.slice(at, t.from)) + '<span class="tk-' + t.cls + '">' + esc(code.slice(t.from, t.to)) + '</span>';
    at = t.to;
  }
  return html + esc(code.slice(at));
}
