/* Editor do CleanNotes: CodeMirror 6.

   Preserva o que o textarea antigo fazia (numeração, colchetes e botões de copiar por bloco,
   botão de copiar por linha, destaque da linha e do bloco, flash ao copiar, Alt+C / Alt+B)
   e acrescenta: Ctrl+Z por aba, buscar e substituir (Ctrl+F), dobrar blocos e seções,
   vários cursores (Alt+clique, Ctrl+D, Alt+arrastar), realce de Markdown e de {{variáveis}}.

   O módulo não conhece o estado do app: recebe `hooks` (onDoc, onSelect, onScroll, onBlur,
   copyLine, copyBlock, varInfo, codeHighlight) e devolve uma API pequena. Cada aba guarda o seu próprio
   EditorState (com o histórico de desfazer e o cursor); a troca de aba é view.setState. */
import { EditorState, StateField, StateEffect, RangeSetBuilder, Prec } from '@codemirror/state';
import {
  EditorView, ViewPlugin, Decoration, GutterMarker, MatchDecorator, gutter, lineNumbers, keymap, placeholder,
  highlightActiveLine, highlightActiveLineGutter, drawSelection, dropCursor, rectangularSelection, crosshairCursor
} from '@codemirror/view';
import { history, historyKeymap, defaultKeymap, indentWithTab } from '@codemirror/commands';
import { markdown, markdownLanguage } from '@codemirror/lang-markdown';
import { syntaxHighlighting, HighlightStyle, foldGutter, foldKeymap, foldService, indentUnit } from '@codemirror/language';
import { search, searchKeymap, highlightSelectionMatches, openSearchPanel } from '@codemirror/search';
import { tags } from '@lezer/highlight';
import * as B from './blocks.js';
import { tokenize, supports } from './highlight.js';
import { VAR_SOURCE } from './vars.js';

const ICON_COPY = '<svg class="i-copy" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true"><rect x="5.5" y="5.5" width="8" height="8" rx="1.5"/><path d="M10.5 3.5v-.5A1.5 1.5 0 0 0 9 1.5H3A1.5 1.5 0 0 0 1.5 3v6A1.5 1.5 0 0 0 3 10.5h.5"/></svg>';
const ICON_CHECK = '<svg class="i-check" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M3 8.5l3.2 3L13 4.5"/></svg>';

/* ---------- Análise de blocos (campo de estado) ---------- */
const compute = text => ({ text, ...B.analyze(text) });
const analysisField = StateField.define({
  create: state => compute(state.doc.toString()),
  update: (value, tr) => (tr.docChanged ? compute(tr.newDoc.toString()) : value)
});

/* ---------- Efeitos: linha/bloco sob o mouse e flash ao copiar ---------- */
const setHoverLine = StateEffect.define();
const setHoverBlock = StateEffect.define();
const setFlash = StateEffect.define();
const refreshVars = StateEffect.define();
const refreshCode = StateEffect.define();
const hasEffect = (tr, effect) => tr.effects.some(e => e.is(effect));

const field = (effect, initial) => StateField.define({
  create: () => initial,
  update(value, tr) {
    for (const e of tr.effects) if (e.is(effect)) return e.value;
    return value;
  }
});
const hoverLineField = field(setHoverLine, -1);
const hoverBlockField = field(setHoverBlock, -1);
const flashField = StateField.define({
  create: () => null,
  update(value, tr) {
    for (const e of tr.effects) if (e.is(setFlash)) return e.value;
    return tr.docChanged ? null : value;
  }
});

/* Decorações de linha: linha sob o mouse, bloco em foco (colchete) e flash. */
const lineDecorations = EditorView.decorations.compute([hoverLineField, hoverBlockField, flashField, analysisField], state => {
  const hover = state.field(hoverLineField), hb = state.field(hoverBlockField), fl = state.field(flashField);
  const a = state.field(analysisField);
  const classes = new Map();
  const add = (i, cls) => { if (i >= 0 && i < state.doc.lines) classes.set(i, (classes.get(i) || '') + ' ' + cls); };
  add(hover, 'cm-hover-line');
  if (hb >= 0 && a.blocks[hb]) for (let i = a.blocks[hb].s; i <= a.blocks[hb].e; i++) add(i, 'cm-hover-block');
  if (fl) for (let i = fl.s; i <= fl.e; i++) add(i, 'cm-flash');
  const builder = new RangeSetBuilder();
  [...classes.keys()].sort((x, y) => x - y).forEach(i => {
    builder.add(state.doc.line(i + 1).from, state.doc.line(i + 1).from, Decoration.line({ class: classes.get(i).trim() }));
  });
  return builder.finish();
});

/* ---------- Colchetes e botões de copiar por bloco (calha à esquerda) ---------- */
class BlockMarker extends GutterMarker {
  constructor(k, kind, code, on) { super(); this.k = k; this.kind = kind; this.code = code; this.on = on; }
  eq(o) { return o.k === this.k && o.kind === this.kind && o.code === this.code && o.on === this.on; }
  toDOM() {
    const el = document.createElement('div');
    el.dataset.b = this.k;
    if (this.kind === 'btn') {
      el.className = 'blk-btn' + (this.code ? ' code' : '') + (this.on ? ' on' : '');
      el.setAttribute('role', 'button');
      el.title = this.code ? 'Copiar código (Alt+B)' : 'Copiar bloco (Alt+B)';
      el.innerHTML = ICON_COPY + ICON_CHECK;
    } else {
      el.className = 'blk-bar' + (this.kind === 'end' ? ' end' : '') + (this.on ? ' on' : '');
    }
    return el;
  }
}
const blockGutter = hooks => gutter({
  class: 'cm-blockgutter',
  lineMarker(view, line) {
    const a = view.state.field(analysisField);
    const i = view.state.doc.lineAt(line.from).number - 1;
    const k = a.lineBlock[i];
    if (k < 0) return null;
    const b = a.blocks[k];
    if (b.e <= b.s) return null; // bloco de uma linha só não ganha colchete
    const on = view.state.field(hoverBlockField) === k;
    return new BlockMarker(k, i === b.s ? 'btn' : i === b.e ? 'end' : 'mid', b.code, on);
  },
  lineMarkerChange: u => u.docChanged || u.transactions.some(tr => hasEffect(tr, setHoverBlock)),
  domEventHandlers: {
    click(view, line, event) {
      const btn = event.target.closest && event.target.closest('.blk-btn');
      if (!btn) return false;
      hooks.copyBlock(+btn.dataset.b);
      return true;
    },
    mouseover(view, line) {
      const a = view.state.field(analysisField);
      const k = a.lineBlock[view.state.doc.lineAt(line.from).number - 1];
      if (view.state.field(hoverBlockField) !== k) view.dispatch({ effects: setHoverBlock.of(k) });
      return false;
    },
    mouseleave(view) {
      if (view.state.field(hoverBlockField) !== -1) view.dispatch({ effects: setHoverBlock.of(-1) });
      return false;
    }
  }
});

/* ---------- Botão de copiar por linha (coluna à direita) ----------
   Aparece na linha do cursor e na linha sob o mouse, só em linhas copiáveis. */
function lineIndexAtClientY(view, clientY) {
  const h = clientY - view.documentTop;
  if (h < 0 || h >= view.contentHeight) return -1;
  return view.state.doc.lineAt(view.lineBlockAtHeight(h).from).number - 1;
}
const copyColumn = hooks => ViewPlugin.fromClass(class {
  constructor(view) {
    this.view = view;
    this.col = document.createElement('div');
    this.col.className = 'cm-copycol';
    view.dom.appendChild(this.col);
    this.buttons = new Map();
    this.onScroll = () => this.place();
    view.scrollDOM.addEventListener('scroll', this.onScroll, { passive: true });
    this.col.addEventListener('mousemove', e => this.hover(lineIndexAtClientY(view, e.clientY)));
    this.col.addEventListener('mouseleave', e => { if (!view.contentDOM.contains(e.relatedTarget)) this.hover(-1); });
    this.col.addEventListener('wheel', e => { view.scrollDOM.scrollTop += e.deltaY; }, { passive: true });
    this.col.addEventListener('click', e => {
      const b = e.target.closest('.cp');
      if (b) hooks.copyLine(+b.dataset.l);
    });
    this.sync();
  }
  hover(i) {
    if (this.view.state.field(hoverLineField) !== i) this.view.dispatch({ effects: setHoverLine.of(i) });
  }
  update(u) {
    if (u.docChanged || u.selectionSet || u.viewportChanged || u.geometryChanged || u.transactions.some(tr => hasEffect(tr, setHoverLine))) this.sync();
  }
  wanted() {
    const { state } = this.view, a = state.field(analysisField), out = new Set();
    const add = i => { if (i >= 0 && i < state.doc.lines && B.isCopyableLine(a.lines, a.lineKind, i)) out.add(i); };
    add(state.field(hoverLineField));
    state.selection.ranges.slice(0, 4).forEach(r => add(state.doc.lineAt(r.head).number - 1));
    return out;
  }
  sync() {
    const want = this.wanted();
    for (const [i, el] of this.buttons) if (!want.has(i)) { el.remove(); this.buttons.delete(i); }
    for (const i of want) {
      if (this.buttons.has(i)) continue;
      const el = document.createElement('button');
      el.className = 'cp show'; el.dataset.l = i; el.title = 'Copiar linha (Alt+C)';
      el.setAttribute('aria-label', 'Copiar linha ' + (i + 1));
      el.innerHTML = ICON_COPY + ICON_CHECK;
      this.col.appendChild(el); this.buttons.set(i, el);
    }
    this.place();
  }
  place() {
    const view = this.view, base = view.dom.getBoundingClientRect().top;
    for (const [i, el] of this.buttons) {
      const block = view.lineBlockAt(view.state.doc.line(i + 1).from);
      el.style.top = (view.documentTop + block.top - base + 1) + 'px';
    }
  }
  destroy() { this.view.scrollDOM.removeEventListener('scroll', this.onScroll); this.col.remove(); }
});

/* ---------- {{variáveis}} no texto ---------- */
const varPlugin = hooks => {
  const matcher = new MatchDecorator({
    regexp: new RegExp(VAR_SOURCE, 'g'),
    decoration: match => {
      const info = hooks.varInfo(match[1]);
      return Decoration.mark({ class: 'cm-var ' + info.cls, attributes: { title: info.title } });
    }
  });
  return ViewPlugin.fromClass(class {
    constructor(view) { this.deco = matcher.createDeco(view); }
    update(u) {
      if (u.docChanged || u.viewportChanged || u.transactions.some(tr => hasEffect(tr, refreshVars))) this.deco = matcher.createDeco(u.view);
    }
  }, { decorations: v => v.deco });
};

/* ---------- Realce dentro dos blocos de código (opcional) ----------
   Usa o mesmo tokenizador do preview (bash, sql, json, yaml, java), pela linguagem da cerca
   (```bash). Só as linhas visíveis; blocos de linguagem desconhecida ficam como estão. */
const MAX_CODE_CHARS = 40000;
const fenceLang = line => { const m = /^\s*(?:`{3,}|~{3,})\s*([\w+#.-]+)/.exec(line); return m ? m[1].toLowerCase() : ''; };
const codePlugin = hooks => ViewPlugin.fromClass(class {
  constructor(view) { this.deco = this.build(view); }
  update(u) {
    if (u.docChanged || u.viewportChanged || u.transactions.some(tr => hasEffect(tr, refreshCode))) this.deco = this.build(u.view);
  }
  build(view) {
    if (!hooks.codeHighlight()) return Decoration.none;
    const a = view.state.field(analysisField), doc = view.state.doc, items = [];
    const seen = new Set();
    for (const { from, to } of view.visibleRanges) {
      const first = doc.lineAt(from).number - 1, last = doc.lineAt(to).number - 1;
      for (let i = first; i <= last; i++) {
        const k = a.lineBlock[i];
        if (k < 0 || seen.has(k)) continue;
        seen.add(k);
        const b = a.blocks[k];
        if (!b.code || b.ce < b.cs) continue;
        const lang = fenceLang(a.lines[b.s]);
        if (!supports(lang)) continue;
        const start = doc.line(b.cs + 1).from, end = doc.line(b.ce + 1).to;
        if (end - start > MAX_CODE_CHARS) continue;
        for (let n = b.cs; n <= b.ce; n++) items.push([doc.line(n + 1).from, Decoration.line({ class: 'cm-code-line' })]);
        for (const t of tokenize(lang, doc.sliceString(start, end))) items.push([start + t.from, Decoration.mark({ class: 'tk-' + t.cls }), start + t.to]);
      }
    }
    items.sort((x, y) => x[0] - y[0] || x[1].startSide - y[1].startSide);
    const builder = new RangeSetBuilder();
    for (const [from, deco, to] of items) builder.add(from, to === undefined ? from : to, deco);
    return builder.finish();
  }
}, { decorations: v => v.deco });

/* ---------- Dobrar: blocos de código e seções por título ---------- */
const headingLevel = line => { const m = /^(#{1,6})\s+\S/.exec(line); return m ? m[1].length : 0; };
const foldBlocks = foldService.of((state, lineStart, lineEnd) => {
  const a = state.field(analysisField);
  const i = state.doc.lineAt(lineStart).number - 1;
  if (a.lineKind[i] === 'code') return null;
  const k = a.lineBlock[i];
  const b = k >= 0 ? a.blocks[k] : null;
  if (b && b.code && b.s === i && b.e > b.s) return { from: lineEnd, to: state.doc.line(b.e + 1).to };
  const level = a.lineKind[i] === 'text' ? headingLevel(a.lines[i]) : 0;
  if (!level) return null;
  let last = i;
  for (let j = i + 1; j < a.lines.length; j++) {
    if (a.lineKind[j] === 'text' && headingLevel(a.lines[j]) && headingLevel(a.lines[j]) <= level) break;
    if (a.lines[j].trim() !== '') last = j;
  }
  return last > i ? { from: lineEnd, to: state.doc.line(last + 1).to } : null;
});

/* ---------- Markdown ---------- */
const mdHighlight = HighlightStyle.define([
  { tag: [tags.heading1, tags.heading2, tags.heading3, tags.heading4, tags.heading5, tags.heading6], class: 'md-head' },
  { tag: tags.strong, class: 'md-strong' },
  { tag: tags.emphasis, class: 'md-em' },
  { tag: tags.strikethrough, class: 'md-strike' },
  { tag: tags.monospace, class: 'md-code' },
  { tag: [tags.link, tags.url], class: 'md-link' },
  { tag: tags.quote, class: 'md-quote' },
  { tag: [tags.processingInstruction, tags.contentSeparator, tags.list, tags.meta], class: 'md-mark' }
]);

const PT = {
  'Find': 'Buscar', 'Replace': 'Substituir', 'next': 'próximo', 'previous': 'anterior', 'all': 'todos',
  'match case': 'diferenciar maiúsculas', 'regexp': 'regex', 'by word': 'palavra inteira', 'replace': 'substituir',
  'replace all': 'substituir todos', 'close': 'fechar', 'Go to line': 'Ir para a linha', 'go': 'ir',
  'current match': 'ocorrência atual', 'on line': 'na linha', 'replaced $ matches': '$ ocorrências substituídas',
  'replaced match on line $': 'ocorrência substituída na linha $', 'Fold line': 'Dobrar', 'Unfold line': 'Expandir',
  'Folded lines': 'Linhas dobradas', 'Unfolded lines': 'Linhas expandidas', 'folded code': 'código dobrado', 'unfold': 'expandir',
  'Selection deleted': 'Seleção apagada', 'Control character': 'Caractere de controle'
};

/* ---------- Aparência (usa as variáveis CSS do app: claro e escuro) ---------- */
const theme = EditorView.theme({
  '&': { height: '100%', backgroundColor: 'var(--paper)', color: 'var(--ink)', fontSize: '14px' },
  '&.cm-focused': { outline: 'none' },
  '.cm-scroller': {
    fontFamily: '"JetBrains Mono", ui-monospace, Menlo, Consolas, monospace', lineHeight: '22px',
    marginRight: '46px', overflow: 'auto'
  },
  '.cm-content': { padding: '14px 0', caretColor: 'var(--accent)' },
  '.cm-line': { padding: '0 16px' },
  '.cm-cursor, .cm-dropCursor': { borderLeftColor: 'var(--accent)' },
  '.cm-selectionBackground, &.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground': { background: 'var(--accent-soft)' },
  '.cm-gutters': { backgroundColor: 'var(--gutter)', color: 'var(--faint)', border: 'none', borderRight: '1px solid var(--line)' },
  '.cm-lineNumbers .cm-gutterElement': { padding: '0 9px 0 6px', minWidth: '34px', fontSize: '12px' },
  '.cm-activeLine': { backgroundColor: 'var(--caret-row)' },
  '.cm-activeLineGutter': { backgroundColor: 'transparent', color: 'var(--ink)' },
  '.cm-foldGutter .cm-gutterElement': { padding: '0 3px', cursor: 'pointer', color: 'var(--faint)' },
  '.cm-foldPlaceholder': { backgroundColor: 'var(--accent-soft)', border: '1px solid var(--line)', color: 'var(--muted)', borderRadius: '4px', padding: '0 6px' },
  '.cm-placeholder': { color: 'var(--faint)' },
  '.cm-panels': { backgroundColor: 'var(--chrome)', color: 'var(--ink)', borderBottom: '1px solid var(--line)', fontFamily: '"IBM Plex Sans", system-ui, sans-serif' },
  '.cm-panels.cm-panels-top': { borderBottom: '1px solid var(--line)' },
  '.cm-search': { padding: '8px 10px', fontSize: '13px', display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '6px' },
  '.cm-search br': { display: 'none' },
  '.cm-search input, .cm-search button': { font: 'inherit', fontSize: '13px' },
  '.cm-textfield': { height: '28px', padding: '0 8px', border: '1px solid var(--line)', borderRadius: '6px', background: 'var(--paper)', color: 'var(--ink)' },
  '.cm-textfield:focus': { outline: 'none', borderColor: 'var(--accent)' },
  '.cm-button': { height: '28px', padding: '0 10px', border: '1px solid var(--line)', borderRadius: '6px', background: 'var(--paper)', backgroundImage: 'none', color: 'var(--ink)', cursor: 'pointer' },
  '.cm-button:hover': { borderColor: 'var(--accent)', color: 'var(--accent)' },
  '.cm-search label': { display: 'inline-flex', alignItems: 'center', gap: '4px', fontSize: '12px', color: 'var(--muted)' },
  '.cm-search [name=close]': { position: 'static', marginLeft: 'auto', background: 'transparent', border: 'none', color: 'var(--muted)', fontSize: '18px' },
  '.cm-searchMatch': { backgroundColor: 'color-mix(in srgb, var(--accent) 22%, transparent)', outline: '1px solid color-mix(in srgb, var(--accent) 45%, transparent)' },
  '.cm-searchMatch-selected': { backgroundColor: 'color-mix(in srgb, var(--accent) 45%, transparent)' },
  '.cm-selectionMatch': { backgroundColor: 'color-mix(in srgb, var(--accent) 14%, transparent)' }
});

export function createEditor(parent, hooks) {
  const extensions = [
    analysisField, hoverLineField, hoverBlockField, flashField, lineDecorations,
    blockGutter(hooks), lineNumbers(), foldGutter({ openText: '▾', closedText: '▸' }), foldBlocks,
    highlightActiveLineGutter(), highlightActiveLine(), drawSelection(), dropCursor(),
    EditorState.allowMultipleSelections.of(true), rectangularSelection(), crosshairCursor(),
    indentUnit.of('  '), EditorState.tabSize.of(2),
    history(),
    markdown({ base: markdownLanguage, addKeymap: false }), syntaxHighlighting(mdHighlight),
    search({ top: true }), highlightSelectionMatches(),
    EditorState.phrases.of(PT),
    placeholder('Escreva em Markdown.\n\nBlocos de código entre ``` ganham botão de copiar.\nLinhas em branco separam os blocos de texto.'),
    varPlugin(hooks), codePlugin(hooks), copyColumn(hooks),
    EditorView.contentAttributes.of({ 'aria-label': 'Anotações em Markdown', spellcheck: 'false', autocorrect: 'off', autocapitalize: 'off' }),
    // Alt+C copia a linha, Alt+B o bloco (por `code`, para funcionar mesmo onde Option+C digita "ç")
    Prec.highest(EditorView.domEventHandlers({
      keydown(e, view) {
        if (!e.altKey || e.ctrlKey || e.metaKey) return false;
        const a = view.state.field(analysisField);
        const line = view.state.doc.lineAt(view.state.selection.main.head).number - 1;
        if (e.code === 'KeyC') { e.preventDefault(); hooks.copyLine(line); return true; }
        if (e.code === 'KeyB') { e.preventDefault(); hooks.copyBlock(a.lineBlock[line], line); return true; }
        return false;
      }
    })),
    keymap.of([...searchKeymap, ...foldKeymap, ...historyKeymap, indentWithTab, ...defaultKeymap]),
    EditorView.domEventHandlers({
      mousemove(e, view) {
        const i = lineIndexAtClientY(view, e.clientY);
        if (view.state.field(hoverLineField) !== i) view.dispatch({ effects: setHoverLine.of(i) });
      },
      mouseleave(e, view) {
        if (!(e.relatedTarget && view.dom.contains(e.relatedTarget)) && view.state.field(hoverLineField) !== -1) view.dispatch({ effects: setHoverLine.of(-1) });
      },
      blur() { hooks.onBlur(); }
    }),
    EditorView.updateListener.of(u => {
      if (u.docChanged) hooks.onDoc(u.state.field(analysisField));
      if (u.selectionSet || u.docChanged) hooks.onSelect();
    }),
    theme
  ];
  const view = new EditorView({ parent, state: EditorState.create({ doc: '', extensions: [...extensions, EditorView.editable.of(false)] }) });
  view.scrollDOM.addEventListener('scroll', () => hooks.onScroll(), { passive: true });
  let flashT;
  const lineCol = () => {
    const head = view.state.selection.main.head, line = view.state.doc.lineAt(head);
    return { line: line.number - 1, col: head - line.from + 1 };
  };

  return {
    view,
    scroller: view.scrollDOM,
    /* Um estado por aba: guarda texto, histórico de desfazer e cursor. */
    makeState: (text, readOnly = false) => EditorState.create({ doc: text, extensions: readOnly ? [...extensions, EditorView.editable.of(false)] : extensions }),
    setState: st => view.setState(st),
    getState: () => view.state,
    analysis: () => view.state.field(analysisField),
    caret: lineCol,
    focus: () => view.focus(),
    hasFocus: () => view.hasFocus,
    contains: node => view.dom.contains(node),
    openSearch: () => openSearchPanel(view),
    refreshVars: () => view.dispatch({ effects: refreshVars.of(null) }),
    refreshCode: () => view.dispatch({ effects: refreshCode.of(null) }),
    /* Rolagem em "linhas fracionárias": serve à rolagem sincronizada com o preview, mesmo com trechos dobrados. */
    lineF() {
      const top = view.scrollDOM.scrollTop - view.documentPadding.top;
      const block = view.lineBlockAtHeight(Math.max(0, top));
      const idx = view.state.doc.lineAt(block.from).number - 1;
      return idx + (block.height ? Math.min(1, Math.max(0, (top - block.top) / block.height)) : 0);
    },
    scrollToLineF(f) {
      const doc = view.state.doc, idx = Math.min(doc.lines - 1, Math.max(0, Math.floor(f)));
      const block = view.lineBlockAt(doc.line(idx + 1).from);
      view.scrollDOM.scrollTop = block.top + (f - idx) * block.height + view.documentPadding.top;
    },
    placeCaret(i) {
      const l = view.state.doc.line(Math.min(view.state.doc.lines, Math.max(0, i) + 1));
      view.dispatch({ selection: { anchor: l.from }, effects: EditorView.scrollIntoView(l.from, { y: 'nearest' }) });
    },
    selectLine(i) {
      const l = view.state.doc.line(i + 1);
      view.dispatch({ selection: { anchor: l.from, head: l.to }, effects: EditorView.scrollIntoView(l.from, { y: 'center' }) });
    },
    flash(s, e) {
      clearTimeout(flashT);
      view.dispatch({ effects: setFlash.of(null) });
      requestAnimationFrame(() => {
        view.dispatch({ effects: setFlash.of({ s, e }) });
        flashT = setTimeout(() => view.dispatch({ effects: setFlash.of(null) }), 900);
      });
    },
    markDone(el) {
      if (!el) return;
      el.classList.add('done');
      setTimeout(() => el.classList.remove('done'), 1200);
    },
    lineButton: i => view.dom.querySelector('.cm-copycol .cp[data-l="' + i + '"]'),
    blockButton: k => view.dom.querySelector('.blk-btn[data-b="' + k + '"]')
  };
}
