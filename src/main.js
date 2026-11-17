import { marked } from 'marked';
import DOMPurify from 'dompurify';
import * as B from './blocks.js';
import * as V from './vars.js';
import { highlight } from './highlight.js';
import { esc, plural } from './util.js';
import { createEditor } from './editor.js';
import welcomeMd from './welcome.md?raw';
import { createTour } from './tour.js';

const PV_PAD = 24, KEY = 'cleannotes:v2', OLD_KEY = 'cleannotes:v1', MAX_NAME = 60;
const PALETTE = [['azul', 'Azul'], ['verde', 'Verde'], ['laranja', 'Laranja'], ['roxo', 'Roxo'], ['rosa', 'Rosa'],
                 ['ciano', 'Ciano'], ['amarelo', 'Amarelo'], ['vermelho', 'Vermelho'], ['cinza', 'Cinza']];
const $ = id => document.getElementById(id);
const panes = $('panes'), pv = $('pv'), pvIn = $('pvIn');
const ICON_COPY = '<svg class="i-copy" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true"><rect x="5.5" y="5.5" width="8" height="8" rx="1.5"/><path d="M10.5 3.5v-.5A1.5 1.5 0 0 0 9 1.5H3A1.5 1.5 0 0 0 1.5 3v6A1.5 1.5 0 0 0 3 10.5h.5"/></svg>';
const ICON_CHECK = '<svg class="i-check" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M3 8.5l3.2 3L13 4.5"/></svg>';
const ICON_PENCIL = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true"><path d="M11 2.5l2.5 2.5L5.5 13 2.5 13.5 3 10.5z"/></svg>';
const ICON_CARET = '<svg class="caret" viewBox="0 0 10 10" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true"><path d="M2 3.5l3 3 3-3"/></svg>';
const ICON_TICK = '<svg class="pm-check" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M3 8.5l3.2 3L13 4.5"/></svg>';

let state, wsDir = '', lines = [''], blocks = [], lineBlock = [], lineKind = [];
let caretLine = 0;
let mode = 'split', pvBlocks = [], pvCur = null;
/* Preferência do editor: realçar a sintaxe dentro dos blocos de código (bash, sql, json, yaml, java). */
const CODEHL_KEY = 'cleannotes:codehl';
let codeHl = (() => { try { return localStorage.getItem(CODEHL_KEY) === '1'; } catch (e) { return false; } })();
const tabView = {};          // rolagem de cada aba (o cursor e o histórico vão dentro do EditorState)
const tabStates = new Map(); // um EditorState por aba: texto, Ctrl+Z e cursor próprios

const uid = () => Math.random().toString(36).slice(2, 10);
const cur = () => state.tabs.find(t => t.id === state.active);

/* ---------- Projetos: nomes, siglas e filtro ---------- */
const normName = s => s.replace(/\s+/g, ' ').trim();
const nameKey = s => normName(s).toLowerCase();
const projectById = id => state.projects.find(p => p.id === id) || null;
const tabProject = t => (t && t.projectId) ? projectById(t.projectId) : null;
const colorOf = p => (p && PALETTE.some(c => c[0] === p.color)) ? p.color : 'cinza';
const pcStyle = color => '--pc:var(--pc-' + (PALETTE.some(c => c[0] === color) ? color : 'cinza') + ')';
/* CleanDev -> TA, Loja Online -> LO, AWS -> AW */
function initials(name){
  const words = name.replace(/([\p{Ll}\p{N}])(\p{Lu})/gu, '$1 $2').split(/[^\p{L}\p{N}]+/u).filter(Boolean);
  if (!words.length) return '··';
  if (words.length === 1) return Array.from(words[0]).slice(0, 2).join('').toUpperCase();
  return (Array.from(words[0])[0] + Array.from(words[1])[0]).toUpperCase();
}
const sigHtml = p => '<span class="sig" style="' + pcStyle(colorOf(p)) + '">' + esc(initials(p.name)) + '</span>';
const validFilter = f => f === 'all' || f === 'none' || !!projectById(f);
const inFilter = (t, f = state.filter) => f === 'all' || (f === 'none' ? !t.projectId : t.projectId === f);
const visibleTabs = () => state.tabs.filter(t => inFilter(t));
const filterLabel = f => f === 'all' ? 'Todos os projetos' : f === 'none' ? 'Sem projeto' : (projectById(f) || {}).name || '';
const countIn = f => state.tabs.filter(t => inFilter(t, f)).length;
const nameTaken = (name, projectId, exceptId) =>
  state.tabs.some(t => t.id !== exceptId && (t.projectId || null) === (projectId || null) && nameKey(t.name) === nameKey(name));
const projectNameTaken = (name, exceptId) => state.projects.some(p => p.id !== exceptId && nameKey(p.name) === nameKey(name));
const fitName = (base, suffix) => suffix.length >= MAX_NAME ? suffix.trim().slice(0, MAX_NAME)
  : base.slice(0, MAX_NAME - suffix.length).trimEnd() + suffix;

/* Primeira abertura: uma única aba (src/welcome.md) com exemplos de cada recurso e dois ambientes de
   variáveis para o exemplo de {{host}}. Sem projetos: o tour ensina a criar o primeiro. */
function seed(){
  const welcome = { id: uid(), name: 'Bem-vindo ao CleanNotes', projectId: null, file: '', content: welcomeMd };
  const dev = { id: uid(), name: 'Desenvolvimento', variables: [
    { key: 'HOST', value: 'dev.exemplo.com.br', description: 'Endereço do ambiente de desenvolvimento' },
    { key: 'PORTA', value: '8080', description: 'Porta da API em desenvolvimento' }
  ] };
  const prod = { id: uid(), name: 'Produção', variables: [
    { key: 'HOST', value: 'app.exemplo.com.br', description: 'Endereço de produção (exemplo: troque pelo seu)' },
    { key: 'PORTA', value: '443', description: 'Porta HTTPS de produção' }
  ] };
  return { projects: [], tabs: [welcome], active: welcome.id, viewMode: 'split', filter: 'all', lastActive: {}, trash: [], envs: [dev, prod], env: dev.id };
}

/* ---------- Persistência ----------
   No app (Tauri), cada aba vira um arquivo .md (em pastas por projeto) e o
   workspace.json guarda projetos, abas e a interface; tudo gravado pelo backend
   em Rust. Aberto direto no navegador, cai para o localStorage (útil para
   mexer só no front). */
const invoke = window.__TAURI__ && window.__TAURI__.core ? window.__TAURI__.core.invoke : null;
const uiSnapshot = () => ({ active: state.active, viewMode: state.viewMode, filter: state.filter, lastActive: state.lastActive, env: state.env });
const writeLocal = async () => {
  try { localStorage.setItem(KEY, JSON.stringify({ projects: state.projects, tabs: state.tabs, trash: state.trash || [], environments: state.envs, ui: uiSnapshot() })); } catch (e) {}
};
const local = {
  load: async () => {
    try {
      const raw = localStorage.getItem(KEY);
      if (raw) return JSON.parse(raw);
      const old = localStorage.getItem(OLD_KEY);
      if (old) {
        const o = JSON.parse(old);
        return { projects: [], ui: { active: o.active, viewMode: o.viewMode, filter: 'all', lastActive: {} },
                 tabs: (o.tabs || []).map(t => ({ id: t.id, name: t.name, projectId: null, content: t.content || '', file: '' })) };
      }
    } catch (e) {}
    return null;
  },
  saveTab: writeLocal, saveUi: writeLocal, saveEnvs: writeLocal,
  /* Mesma regra do backend: aba em branco some; com conteúdo vai para a lixeira. */
  trashTab: async (id, tab) => {
    const keep = !!(tab && tab.content.trim());
    if (keep) {
      const p = tabProject(tab);
      state.trash.push({ id, name: tab.name, projectId: p ? p.id : null, projectName: p ? p.name : null, projectColor: p ? p.color : null,
                         deletedAt: Math.floor(Date.now() / 1000), file: '', content: tab.content });
    }
    await writeLocal(); return keep;
  },
  listTrash: async () => [...state.trash].sort((a, b) => b.deletedAt - a.deletedAt),
  restoreTrash: async id => {
    const i = state.trash.findIndex(t => t.id === id);
    if (i < 0) throw 'item não encontrado na lixeira';
    const it = state.trash[i], pid = projectById(it.projectId) ? it.projectId : null;
    let name = it.name;
    if (nameTaken(name, pid, null)) {
      const first = fitName(it.name, ' (restaurada)'); name = first;
      for (let k = 2; nameTaken(name, pid, null); k++) name = fitName(first, ' ' + k);
    }
    state.trash.splice(i, 1); await writeLocal();
    return { id, name, projectId: pid, file: '', content: it.content };
  },
  emptyTrash: async () => { const n = state.trash.length; state.trash = []; await writeLocal(); return n; },
  importTab: async (id, picked, projectId) => {
    let name = normName(picked.name).slice(0, MAX_NAME) || 'Sem nome';
    const base = name;
    for (let k = 2; nameTaken(name, projectId, null); k++) name = fitName(base, ' ' + k);
    return { id, name, projectId, file: '', content: picked.content };
  },
  createTab: async () => { await writeLocal(); return ''; },
  updateTab: async () => { await writeLocal(); return ''; },
  createProject: async () => { await writeLocal(); return ''; },
  updateProject: async () => { await writeLocal(); return {}; },
  /* Mesma regra do backend: nada é apagado; nome repetido em "Sem projeto" ganha " (Projeto)". */
  deleteProject: async id => {
    const p = projectById(id), files = {}, names = {};
    const taken = new Set(state.tabs.filter(t => !t.projectId).map(t => nameKey(t.name)));
    state.tabs.filter(t => t.projectId === id).forEach(t => {
      let n = t.name;
      if (taken.has(nameKey(n))) {
        const first = fitName(t.name, ' (' + p.name + ')'); n = first;
        for (let k = 2; taken.has(nameKey(n)); k++) n = fitName(first, ' ' + k);
      }
      taken.add(nameKey(n));
      if (n !== t.name) names[t.id] = n;
      files[t.id] = '';
    });
    const filter = state.filter === id ? 'all' : state.filter;
    return { files, names, filter };
  }
};
const api = invoke ? {
  load: () => invoke('load_workspace'),
  saveTab: (id, content) => invoke('save_tab', { id, content }),
  saveUi: ui => invoke('save_ui', { ui }),
  saveEnvs: envs => invoke('save_environments', { environments: envs }),
  createTab: (id, name, projectId) => invoke('create_tab', { id, name, projectId }),
  updateTab: (id, name, projectId) => invoke('update_tab', { id, name, projectId }),
  trashTab: id => invoke('trash_tab', { id }),
  listTrash: () => invoke('list_trash'),
  restoreTrash: id => invoke('restore_trash', { id }),
  emptyTrash: () => invoke('empty_trash'),
  importTab: (id, path, projectId) => invoke('import_tab', { id, path, projectId }),
  createProject: (id, name, color) => invoke('create_project', { id, name, color }),
  updateProject: (id, name, color) => invoke('update_project', { id, name, color }),
  deleteProject: id => invoke('delete_project', { id })
} : local;

function setSave(t){ $('saveState').textContent = t; }
const dirtyTabs = new Set();
let uiDirty = false, saveT, queue = Promise.resolve(), reloading = false, envDirty = false;
function markTabDirty(id){ dirtyTabs.add(id); scheduleSave(); }
function markUiDirty(){ uiDirty = true; scheduleSave(); }
function markEnvDirty(){ envDirty = true; scheduleSave(); }
/* Só vai para o disco o que é válido: chave com caracteres seguros e sem repetição. */
function envPayload(){
  return state.envs.map(e => {
    const seen = new Set();
    const variables = e.variables.filter(v => {
      const k = v.key.toLowerCase();
      if (!validKey(v.key) || seen.has(k)) return false;
      seen.add(k); return true;
    }).map(v => ({ key: v.key, value: v.value, description: v.description, secret: !!v.secret && !!invoke, locked: !!v.locked }));
    return { id: e.id, name: e.name, variables };
  });
}
function scheduleSave(){ setSave('Salvando…'); clearTimeout(saveT); saveT = setTimeout(flush, 300); }
/* Todas as gravações passam por uma fila: a aba é criada antes de receber conteúdo,
   e nunca dois comandos mexem nos mesmos arquivos ao mesmo tempo. */
function run(job){ const p = queue.then(job); queue = p.catch(() => {}); return p; }
function fail(msg, e){ setSave('Erro ao salvar'); toast(msg + ': ' + e); }
/* Operação estrutural (criar, mover, excluir): devolve o resultado ou undefined se falhar. */
function enqueue(job, msg){
  setSave('Salvando…');
  return run(job).then(r => { if (!dirtyTabs.size && !uiDirty) setSave('Salvo'); return r; }, e => { fail(msg, e); });
}
function flush(){
  clearTimeout(saveT);
  return run(async () => {
    if (reloading) return; // a pasta das notas está mudando; a página recarrega em seguida
    const ids = [...dirtyTabs]; dirtyTabs.clear();
    const ui = uiDirty; uiDirty = false;
    const envs = envDirty; envDirty = false;
    try {
      for (const id of ids) {
        const t = state.tabs.find(x => x.id === id);
        if (t) await api.saveTab(id, t.content);
      }
      if (envs) await api.saveEnvs(envPayload());
      if (ui) await api.saveUi(uiSnapshot());
      if (!dirtyTabs.size && !uiDirty && !envDirty) setSave('Salvo');
    } catch (e) {
      ids.forEach(id => dirtyTabs.add(id)); if (ui) uiDirty = true; if (envs) envDirty = true;
      fail('Não foi possível salvar', e);
    }
  });
}

/* ---------- Abas ---------- */
function renderTabs(){
  const el = $('tabs'); el.innerHTML = '';
  let activeEl = null;
  const showPc = state.filter === 'all';
  visibleTabs().forEach(t => {
    const p = tabProject(t);
    const tab = document.createElement('div');
    tab.className = 'tab' + (t.id === state.active ? ' active' : '');
    tab.setAttribute('role', 'tab');
    tab.setAttribute('aria-selected', t.id === state.active);
    tab.dataset.id = t.id;
    tab.tabIndex = 0;
    tab.title = t.name + (p ? ' · ' + p.name : '') + ' (clique duas vezes para renomear; botão direito para mais opções)';
    if (showPc && p) { tab.dataset.pc = colorOf(p); tab.setAttribute('style', pcStyle(colorOf(p))); }
    if (showPc && p) { const sig = document.createElement('span'); sig.innerHTML = sigHtml(p); tab.append(sig.firstChild); }
    const name = document.createElement('span'); name.className = 'tab-name'; name.textContent = t.name;
    const x = document.createElement('button'); x.className = 'tab-close'; x.innerHTML = '&times;';
    x.setAttribute('aria-label', 'Fechar aba ' + t.name);
    tab.append(name, x);
    tab.addEventListener('click', e => { if (!x.contains(e.target)) switchTab(t.id); });
    tab.addEventListener('dblclick', e => { if (!x.contains(e.target)) openModal('rename', t.id); });
    tab.addEventListener('contextmenu', e => { e.preventDefault(); openCtx(t.id, e.clientX, e.clientY); });
    tab.addEventListener('keydown', e => {
      if (e.key === 'Enter') switchTab(t.id);
      if (e.key === 'F2') { e.stopPropagation(); openModal('rename', t.id); }
      if (e.key === 'ContextMenu' || (e.shiftKey && e.key === 'F10')) {
        e.preventDefault();
        const r = tab.getBoundingClientRect(); openCtx(t.id, r.left, r.bottom);
      }
    });
    x.addEventListener('click', e => { e.stopPropagation(); requestClose(t.id); });
    el.append(tab);
    if (t.id === state.active) activeEl = tab;
  });
  if (activeEl) activeEl.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  renderChrome();
}
/* Seletor de projeto, título da janela, caminho do arquivo e mensagem de aba vazia. */
function renderChrome(){
  const b = $('projBtn'), p = projectById(state.filter);
  const dot = state.filter === 'all' ? 'all' : state.filter === 'none' ? 'none' : '';
  b.innerHTML = '<span class="pdot ' + dot + '"' + (p ? ' style="' + pcStyle(colorOf(p)) + '"' : '') + '></span><span class="lbl">' +
                esc(filterLabel(state.filter)) + '</span>' + ICON_CARET;
  b.setAttribute('aria-label', 'Projeto: ' + filterLabel(state.filter));
  const ev = activeEnv();
  envBtn.innerHTML = '<span class="lbl"><span class="env-k">Ambiente:</span> ' + esc(ev ? ev.name : 'nenhum') + '</span>' + ICON_CARET;
  envBtn.setAttribute('aria-label', 'Ambiente de variáveis: ' + (ev ? ev.name : 'nenhum'));
  const t = cur(), tp = tabProject(t);
  $('empty').hidden = !!t;
  $('emptyMsg').textContent = state.filter === 'all'
    ? 'Nenhuma aba aberta. Crie uma aba com o nome de um projeto, cliente ou ambiente para começar a anotar.'
    : state.filter === 'none' ? 'Não há abas sem projeto. Crie uma aba ou mude o filtro de projeto.'
    : 'Este projeto ainda não tem abas. Crie a primeira para começar a anotar.';
  const fi = $('fileInfo');
  fi.textContent = t && t.file ? t.file : '';
  fi.title = t && t.file ? (wsDir ? wsDir + '/' : '') + t.file : '';
  const title = t ? t.name + (tp ? ' · ' + tp.name : '') + ' — CleanNotes' : 'CleanNotes';
  document.title = title;
  try { window.__TAURI__.window.getCurrentWindow().setTitle(title); } catch (e) {}
}
function saveView(){
  if (!state.active) return;
  tabView[state.active] = { st: editor.scroller.scrollTop, sl: editor.scroller.scrollLeft, pv: pv.scrollTop };
  tabStates.set(state.active, editor.getState());
}
/* A aba ativa e o filtro de projeto lembram um do outro. */
function setActive(id){
  state.active = id;
  const t = state.tabs.find(x => x.id === id);
  if (t) { state.lastActive[state.filter] = id; state.lastActive[t.projectId || 'none'] = id; }
  markUiDirty();
}
function switchTab(id){
  if (id === state.active) return;
  saveView();
  setActive(id);
  loadEditor(); renderTabs();
}
function loadEditor(){
  const t = cur();
  $('empty').hidden = !!t;
  editor.setState(t ? (tabStates.get(t.id) || editor.makeState(t.content)) : editor.makeState('', true));
  syncAnalysis(editor.analysis());
  const v = t && tabView[t.id];
  const scroll = () => { editor.scroller.scrollTop = v ? v.st : 0; editor.scroller.scrollLeft = v ? v.sl : 0; };
  scroll(); requestAnimationFrame(scroll);
  updateCaret();
  renderPreview();
  if (v && mode === 'preview') pv.scrollTop = v.pv; else if (!v) pv.scrollTop = 0;
}
function setFilter(f){
  if (!validFilter(f)) f = 'all';
  if (f === state.filter) return;
  saveView();
  state.filter = f;
  const vis = visibleTabs(), ok = id => !!id && vis.some(t => t.id === id);
  const next = ok(state.lastActive[f]) ? state.lastActive[f] : ok(state.active) ? state.active : (vis[0] ? vis[0].id : null);
  const changed = next !== state.active;
  state.active = next;
  if (next) state.lastActive[f] = next;
  markUiDirty();
  if (changed) loadEditor();
  renderTabs();
}
/* Garante que a aba ativa existe e aparece no filtro atual. */
function fixActive(){
  const vis = visibleTabs();
  if (vis.some(t => t.id === state.active)) return false;
  const last = vis.find(t => t.id === state.lastActive[state.filter]);
  state.active = last ? last.id : (vis[0] ? vis[0].id : null);
  return true;
}
function createTab(name, projectId){
  const t = { id: uid(), name, projectId: projectId || null, file: '', content: '' };
  saveView();
  state.tabs.push(t);
  if (!inFilter(t)) state.filter = t.projectId || 'none';
  setActive(t.id);
  loadEditor(); renderTabs();
  enqueue(() => api.createTab(t.id, t.name, t.projectId).then(f => { t.file = f; renderChrome(); }), 'Não foi possível criar a aba');
  if (mode === 'preview') setMode('split');
  editor.focus();
  toast('Aba “' + name + '” criada');
}
function closeTab(id){
  const i = state.tabs.findIndex(t => t.id === id);
  if (i < 0) return;
  const tab = state.tabs[i], name = tab.name, kept = tab.content.trim() !== '';
  const vi = visibleTabs().findIndex(t => t.id === id);
  state.tabs.splice(i, 1); delete tabView[id]; tabStates.delete(id);
  /* O que ainda não foi gravado entra no arquivo antes de ele ir para a lixeira. */
  enqueue(async () => {
    if (dirtyTabs.delete(id)) await api.saveTab(id, tab.content);
    return api.trashTab(id, tab);
  }, 'Não foi possível fechar a aba');
  if (state.active === id) {
    const vis = visibleTabs(), next = vis[vi] || vis[vi - 1];
    setActive(next ? next.id : null);
    loadEditor();
  }
  renderTabs();
  toast(kept ? 'Aba “' + name + '” fechada. Ela está na lixeira.' : 'Aba “' + name + '” fechada');
}
function requestClose(id){
  const t = state.tabs.find(x => x.id === id);
  if (!t) return;
  if (t.content.trim() === '') closeTab(id); else openModal('close', id);
}
/* Renomear e/ou mover: o arquivo acompanha no disco. */
function editTab(t, name, projectId){
  t.name = name; t.projectId = projectId || null;
  if (!inFilter(t) && state.active === t.id) state.filter = t.projectId || 'none';
  if (fixActive()) loadEditor();
  renderTabs();
  enqueue(() => api.updateTab(t.id, t.name, t.projectId).then(f => { t.file = f; renderChrome(); }), 'Não foi possível atualizar a aba');
}

/* ---------- Projetos ---------- */
function createProject(name, color){
  const p = { id: uid(), name, color, folder: '' };
  state.projects.push(p);
  enqueue(() => api.createProject(p.id, p.name, p.color).then(f => { p.folder = f; }), 'Não foi possível criar o projeto');
  return p;
}
function editProject(p, name, color){
  p.name = name; p.color = color;
  renderTabs();
  enqueue(() => api.updateProject(p.id, name, color).then(files => {
    state.tabs.forEach(t => { if (files && files[t.id]) t.file = files[t.id]; });
    renderChrome();
  }), 'Não foi possível atualizar o projeto');
}
async function removeProject(id){
  const p = projectById(id); if (!p) return;
  const res = await enqueue(() => api.deleteProject(id), 'Não foi possível excluir o projeto');
  if (!res) return;
  const moved = state.tabs.filter(t => t.projectId === id);
  moved.forEach(t => {
    t.projectId = null;
    if (res.names && res.names[t.id]) t.name = res.names[t.id];
    if (res.files && res.files[t.id]) t.file = res.files[t.id];
  });
  state.projects = state.projects.filter(x => x.id !== id);
  delete state.lastActive[id];
  if (state.filter === id) state.filter = 'all';
  fixActive(); markUiDirty();
  loadEditor(); renderTabs();
  toast(moved.length ? 'Projeto “' + p.name + '” excluído. ' + plural(moved.length, 'aba foi', 'abas foram') + ' para “Sem projeto”'
                     : 'Projeto “' + p.name + '” excluído');
}

/* ---------- Menus (projetos e contexto da aba) ---------- */
const projBtn = $('projBtn'), projMenu = $('projMenu'), ctx = $('ctxMenu');
function menuKeys(menu, e, close, back){
  const items = [...menu.querySelectorAll('button')];
  const i = items.indexOf(document.activeElement);
  if (e.key === 'ArrowDown') { e.preventDefault(); items[(i + 1) % items.length].focus(); }
  else if (e.key === 'ArrowUp') { e.preventDefault(); items[(i - 1 + items.length) % items.length].focus(); }
  else if (e.key === 'Home') { e.preventDefault(); items[0].focus(); }
  else if (e.key === 'End') { e.preventDefault(); items[items.length - 1].focus(); }
  else if (e.key === 'Escape') { e.preventDefault(); close(); if (back) back.focus(); }
  else if (e.key === 'Tab') close();
}
function closeProjMenu(){ projMenu.hidden = true; projBtn.setAttribute('aria-expanded', 'false'); }
function closeCtx(){ ctx.hidden = true; }
function openProjMenu(){
  closeCtx(); closeEnvMenu();
  projMenu.innerHTML = '';
  const row = (f, label, dot, count, edit) => {
    const r = document.createElement('div'); r.className = 'pm-row'; r.setAttribute('role', 'none');
    if (f === state.filter) r.setAttribute('aria-current', 'true');
    const b = document.createElement('button'); b.className = 'pm-item'; b.setAttribute('role', 'menuitem');
    b.innerHTML = ICON_TICK + dot + '<span class="pm-name">' + esc(label) + '</span><span class="pm-count">' + count + '</span>';
    b.addEventListener('click', () => { closeProjMenu(); setFilter(f); });
    r.append(b);
    if (edit) {
      const e = document.createElement('button'); e.className = 'pm-edit'; e.innerHTML = ICON_PENCIL;
      e.setAttribute('role', 'menuitem'); e.title = 'Editar projeto'; e.setAttribute('aria-label', 'Editar projeto ' + label);
      e.addEventListener('click', () => { closeProjMenu(); openModal('project', f); });
      r.append(e);
    }
    projMenu.append(r);
  };
  row('all', 'Todos os projetos', '<span class="pdot all"></span>', countIn('all'));
  state.projects.forEach(p => row(p.id, p.name, '<span class="pdot" style="' + pcStyle(colorOf(p)) + '"></span>', countIn(p.id), true));
  row('none', 'Sem projeto', '<span class="pdot none"></span>', countIn('none'));
  const sep = document.createElement('div'); sep.className = 'pm-sep'; sep.setAttribute('role', 'separator'); projMenu.append(sep);
  const n = document.createElement('button'); n.className = 'pm-item pm-new'; n.setAttribute('role', 'menuitem'); n.textContent = '+ Novo projeto';
  n.addEventListener('click', () => { closeProjMenu(); openModal('project', null); });
  projMenu.append(n);
  projMenu.hidden = false; projBtn.setAttribute('aria-expanded', 'true');
  const sel = projMenu.querySelector('.pm-row[aria-current] .pm-item') || projMenu.querySelector('button');
  sel.focus();
}
projBtn.addEventListener('click', () => { if (projMenu.hidden) openProjMenu(); else closeProjMenu(); });
projMenu.addEventListener('keydown', e => menuKeys(projMenu, e, closeProjMenu, projBtn));

function openCtx(tabId, x, y){
  closeProjMenu(); closeEnvMenu();
  ctx.innerHTML = '';
  const add = (label, key, fn) => {
    const b = document.createElement('button'); b.setAttribute('role', 'menuitem');
    b.innerHTML = '<span>' + esc(label) + '</span>' + (key ? '<kbd>' + key + '</kbd>' : '');
    b.addEventListener('click', () => { closeCtx(); fn(); });
    ctx.append(b);
  };
  add('Renomear', 'F2', () => openModal('rename', tabId));
  add('Mover para projeto…', '', () => openModal('move', tabId));
  add('Exportar como .md…', '', () => exportTab(tabId));
  add('Fechar aba', '', () => requestClose(tabId));
  ctx.dataset.tab = tabId;
  ctx.hidden = false;
  ctx.style.left = Math.max(4, Math.min(x, window.innerWidth - ctx.offsetWidth - 4)) + 'px';
  ctx.style.top = Math.max(4, Math.min(y, window.innerHeight - ctx.offsetHeight - 4)) + 'px';
  ctx.querySelector('button').focus();
}
ctx.addEventListener('keydown', e => {
  const tab = document.querySelector('.tab[data-id="' + ctx.dataset.tab + '"]');
  menuKeys(ctx, e, closeCtx, tab);
});
document.addEventListener('mousedown', e => {
  if (!projMenu.hidden && !projMenu.contains(e.target) && !projBtn.contains(e.target)) closeProjMenu();
  if (!ctx.hidden && !ctx.contains(e.target)) closeCtx();
});
window.addEventListener('blur', () => { closeProjMenu(); closeCtx(); });
window.addEventListener('resize', () => { closeProjMenu(); closeCtx(); });
$('tabs').addEventListener('scroll', closeCtx);

/* ---------- Variáveis de ambiente ----------
   Como no Postman: um ambiente (ex.: "Desenvolvimento") tem variáveis com chave, valor
   e descrição. `{{host}}` no texto vira o valor do ambiente ativo ao copiar (linha,
   bloco ou preview). A chave não diferencia maiúsculas; variável sem valor não é
   substituída: fica como está, destacada, e o aviso aparece ao copiar. */
const VAR_RE = new RegExp(V.VAR_SOURCE, 'g');
const validKey = V.validKey;
const activeEnv = () => state.envs.find(e => e.id === state.env) || null;
const envVariables = () => { const e = activeEnv(); return e ? e.variables : []; };
const varMap = () => V.map(envVariables());
const resolveVars = text => V.resolve(text, envVariables());
const varNote = r => r.missing.length ? ' · sem valor: ' + r.missing.map(n => '{{' + n + '}}').join(', ')
  : r.used.length ? ' · ' + plural(r.used.length, 'variável substituída', 'variáveis substituídas') + (r.secret ? ' (inclui segredo)' : '') : '';
function varTitle(name, hit){
  const env = activeEnv();
  if (hit) return '{{' + hit.key + '}}' + (env ? ' · ' + env.name : '') + (hit.secret ? ' · segredo: o valor é copiado, mas não exibido' : '') + (hit.description ? ' · ' + hit.description : '');
  return env ? 'Sem valor para “' + name + '” no ambiente “' + env.name + '”' : 'Nenhum ambiente selecionado';
}
function varHtml(name){
  const hit = varMap().get(name.toLowerCase());
  return '<span class="var ' + (hit ? 'ok' : 'miss') + (hit && hit.secret ? ' secret' : '') + '" data-name="' + esc(name) + '" title="' + esc(varTitle(name, hit)) + '">' +
         esc(hit ? (hit.secret ? '••••••' : hit.value) : '{{' + name + '}}') + '</span>';
}

/* Preview: realça o código e troca {{variáveis}} por chips com o valor do ambiente ativo.
   Em blocos de código as variáveis viram marcadores (área de uso privado do Unicode) antes
   do realce, para nenhuma regra quebrar uma variável no meio. */
function decoratePreview(){
  pvIn.querySelectorAll('pre code').forEach(code => {
    const lang = ((code.className.match(/language-([\w+#.-]+)/) || [])[1] || '').toLowerCase();
    const names = [];
    const text = code.textContent.replace(VAR_RE, (all, name) => {
      if (names.length >= 0x1700) return all;
      names.push(name);
      return '' + String.fromCharCode(0xE100 + names.length - 1) + '';
    });
    let html = highlight(lang, text);
    if (names.length) html = html.replace(/([-])/g, (_, c) => varHtml(names[c.charCodeAt(0) - 0xE100]));
    code.innerHTML = html;
  });
  if (!pvIn.textContent.includes('{{')) return;
  const walker = document.createTreeWalker(pvIn, NodeFilter.SHOW_TEXT, {
    acceptNode: n => n.nodeValue.includes('{{') && !n.parentElement.closest('pre') ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT
  });
  const nodes = [];
  while (walker.nextNode()) nodes.push(walker.currentNode);
  nodes.forEach(n => {
    const src = n.nodeValue, frag = document.createDocumentFragment();
    let last = 0;
    src.replace(VAR_RE, (all, name, off) => {
      frag.append(src.slice(last, off));
      const holder = document.createElement('span'); holder.innerHTML = varHtml(name);
      frag.append(holder.firstChild);
      last = off + all.length;
      return all;
    });
    if (!last) return;
    frag.append(src.slice(last));
    n.replaceWith(frag);
  });
}

/* ---------- Menu de ambientes ---------- */
const envBtn = $('envBtn'), envMenu = $('envMenu');
function closeEnvMenu(){ envMenu.hidden = true; envBtn.setAttribute('aria-expanded', 'false'); }
function setEnv(id){
  state.env = id; markUiDirty();
  renderChrome(); renderPreview(); editor.refreshVars();
  const e = activeEnv();
  toast(e ? 'Ambiente: ' + e.name : 'Nenhum ambiente: as {{variáveis}} não são substituídas');
}
function openEnvMenu(){
  closeProjMenu(); closeCtx();
  envMenu.innerHTML = '';
  const row = (id, label, count) => {
    const r = document.createElement('div'); r.className = 'pm-row'; r.setAttribute('role', 'none');
    if ((state.env || null) === id) r.setAttribute('aria-current', 'true');
    const b = document.createElement('button'); b.className = 'pm-item'; b.setAttribute('role', 'menuitem');
    b.innerHTML = ICON_TICK + '<span class="pm-name">' + esc(label) + '</span>' + (count === null ? '' : '<span class="pm-count">' + plural(count, 'variável', 'variáveis') + '</span>');
    b.addEventListener('click', () => { closeEnvMenu(); if ((state.env || null) !== id) setEnv(id); });
    r.append(b); envMenu.append(r);
  };
  row(null, 'Sem ambiente', null);
  state.envs.forEach(e => row(e.id, e.name, e.variables.filter(v => validKey(v.key)).length));
  const sep = document.createElement('div'); sep.className = 'pm-sep'; sep.setAttribute('role', 'separator'); envMenu.append(sep);
  const g = document.createElement('button'); g.className = 'pm-item pm-new'; g.setAttribute('role', 'menuitem'); g.textContent = 'Gerenciar ambientes e variáveis…';
  g.addEventListener('click', () => { closeEnvMenu(); openModal('envs'); });
  envMenu.append(g);
  envMenu.hidden = false; envBtn.setAttribute('aria-expanded', 'true');
  (envMenu.querySelector('.pm-row[aria-current] .pm-item') || g).focus();
}
envBtn.addEventListener('click', () => { if (envMenu.hidden) openEnvMenu(); else closeEnvMenu(); });
envMenu.addEventListener('keydown', e => menuKeys(envMenu, e, closeEnvMenu, envBtn));
document.addEventListener('mousedown', e => { if (!envMenu.hidden && !envMenu.contains(e.target) && !envBtn.contains(e.target)) closeEnvMenu(); });
window.addEventListener('blur', closeEnvMenu);
window.addEventListener('resize', closeEnvMenu);

/* ---------- Editor (CodeMirror) ----------
   A lógica de blocos mora em blocks.js (testada); o desenho do editor, em editor.js. */
function syncAnalysis(a){
  ({ lines, blocks, lineBlock, lineKind } = a);
  $('blkCount').textContent = plural(blocks.length, 'bloco', 'blocos');
}
function updateCaret(){
  const c = editor.caret();
  caretLine = c.line;
  $('pos').textContent = 'Ln ' + (c.line + 1) + ', Col ' + c.col;
  markPreviewCaret();
}
/* Como uma {{variável}} aparece no editor: azul (tem valor), vermelha (sem valor) ou segredo. */
function varInfo(name){
  const hit = varMap().get(name.toLowerCase());
  if (!hit) return { cls: 'miss', title: varTitle(name, null) };
  return { cls: hit.secret ? 'ok secret' : 'ok', title: varTitle(name, hit) + (hit.secret ? '' : ' → ' + hit.value) };
}
const editor = createEditor($('editor'), {
  onDoc(a) {
    const t = cur(); if (!t) return;
    t.content = a.text;
    syncAnalysis(a); markTabDirty(t.id); schedulePreview();
  },
  onSelect: () => updateCaret(),
  onScroll: () => syncFromEditor(),
  onBlur: () => { if (dirtyTabs.size || uiDirty) flush(); },
  copyLine: i => copyLine(i),
  copyBlock: k => copyBlock(k),
  varInfo,
  codeHighlight: () => codeHl
});

/* ---------- Cópia ---------- */
async function copyText(text){
  try { await navigator.clipboard.writeText(text); return true; }
  catch (e) {
    const prev = document.activeElement;
    const t = document.createElement('textarea');
    t.value = text; t.setAttribute('readonly', ''); t.style.position = 'fixed'; t.style.opacity = '0';
    document.body.append(t); t.select();
    let ok = false; try { ok = document.execCommand('copy'); } catch (_) {}
    t.remove();
    if (prev && prev.focus) prev.focus();
    return ok;
  }
}
function flash(s, e){ editor.flash(s, e); }
function markDone(btn){
  if (!btn) return;
  btn.classList.add('done');
  setTimeout(() => btn.classList.remove('done'), 1200);
}
const copyFail = () => toast('Não foi possível copiar. Selecione o texto e use Ctrl+C.');
async function copyLine(i){
  if (i < 0 || i >= lines.length) return;
  if (lineKind[i] === 'fence') { toast('Essa linha marca o início ou o fim de um bloco de código'); return; }
  const text = lines[i].trimEnd();
  if (text.trim() === '') { toast('Linha vazia, nada para copiar'); return; }
  const r = resolveVars(text);
  if (await copyText(r.text)) { flash(i, i); markDone(editor.lineButton(i)); toast('Linha ' + (i + 1) + ' copiada' + varNote(r), r.missing.length ? 3600 : 0); }
  else copyFail();
}
const blockPayload = k => B.blockPayload(lines, blocks[k]);
async function copyBlock(k){
  const b = blocks[k];
  if (!b) { toast('O cursor não está em um bloco'); return; }
  const p = blockPayload(k);
  if (!p.text.trim()) { toast('Bloco de código vazio, nada para copiar'); return; }
  const r = resolveVars(p.text);
  if (await copyText(r.text)) {
    flash(b.s, b.e);
    markDone(editor.blockButton(k));
    toast((b.code ? 'Código copiado (' : 'Bloco copiado (') + plural(p.count, 'linha', 'linhas') + ')' + varNote(r), r.missing.length ? 3600 : 0);
  } else copyFail();
}

/* ---------- Preview Markdown ---------- */
let mdReady = false;
function setupMarkdown(){
  marked.use({ gfm: true, breaks: true });
  DOMPurify.addHook('afterSanitizeAttributes', node => {
    if (node.tagName === 'A') { node.setAttribute('target', '_blank'); node.setAttribute('rel', 'noopener noreferrer'); }
  });
  return true;
}

let pvT;
function schedulePreview(){ clearTimeout(pvT); pvT = setTimeout(renderPreview, 120); }
function renderPreview(){
  if (mode === 'editor') return;
  if (!cur()) { pvIn.innerHTML = ''; pvBlocks = []; return; }
  const src = cur().content;
  if (!src.trim()) { pvIn.innerHTML = '<p class="pv-empty">A visualização aparece aqui conforme você escreve.</p>'; pvBlocks = []; return; }
  if (!mdReady) { pvIn.innerHTML = '<p class="pv-warn">Não foi possível carregar o renderizador de Markdown.</p>'; pvBlocks = []; return; }
  let html = '', line = 0;
  try {
    const toks = marked.lexer(src);
    for (const tok of toks) {
      const start = line;
      line += (tok.raw.match(/\n/g) || []).length;
      if (tok.type === 'space') continue;
      html += '<div class="md-blk" data-line="' + start + '">' + marked.parser([tok]) + '</div>';
    }
  } catch (e) {
    html = '<p class="pv-warn">Não foi possível renderizar este Markdown.</p>';
  }
  pvIn.innerHTML = DOMPurify.sanitize(html, { ADD_ATTR: ['target'] });
  pvIn.querySelectorAll('pre').forEach(pre => {
    const wrap = document.createElement('div'); wrap.className = 'pre-wrap';
    pre.replaceWith(wrap); wrap.append(pre);
    const btn = document.createElement('button');
    btn.className = 'pv-copy'; btn.title = 'Copiar código'; btn.setAttribute('aria-label', 'Copiar código');
    btn.innerHTML = ICON_COPY + ICON_CHECK;
    wrap.append(btn);
  });
  pvIn.querySelectorAll('table').forEach(tb => {
    const wrap = document.createElement('div'); wrap.className = 'tbl-wrap';
    tb.replaceWith(wrap); wrap.append(tb);
  });
  decoratePreview();
  pvBlocks = Array.from(pvIn.querySelectorAll('.md-blk')).map(el => ({ el, line: +el.dataset.line }));
  pvCur = null;
  markPreviewCaret();
  syncFromEditor();
}
function pvIndexForLine(l){
  let idx = -1;
  for (let i = 0; i < pvBlocks.length; i++) { if (pvBlocks[i].line <= l) idx = i; else break; }
  return idx;
}
function markPreviewCaret(){
  if (mode !== 'split' || !pvBlocks.length) return;
  const idx = pvIndexForLine(caretLine);
  const el = idx >= 0 ? pvBlocks[idx].el : null;
  if (el === pvCur) return;
  if (pvCur) pvCur.classList.remove('cur');
  pvCur = el;
  if (el) el.classList.add('cur');
}

pvIn.addEventListener('click', async e => {
  const btn = e.target.closest('.pv-copy'); if (!btn) return;
  const code = btn.parentElement.querySelector('pre code') || btn.parentElement.querySelector('pre');
  /* O chip de segredo mostra ••••••; o que vai para a área de transferência é o valor real. */
  const copy = code.cloneNode(true);
  copy.querySelectorAll('.var.ok').forEach(el => { const v = varMap().get(el.dataset.name.toLowerCase()); if (v) el.textContent = v.value; });
  const text = copy.textContent.replace(/\n$/, '');
  if (await copyText(text)) {
    markDone(btn);
    const blk = btn.closest('.md-blk');
    if (blk) {
      blk.classList.remove('flash'); void blk.offsetWidth; blk.classList.add('flash');
      const k = lineBlock[+blk.dataset.line];
      if (k >= 0 && blocks[k]) flash(blocks[k].s, blocks[k].e);
    }
    const miss = [...new Set([...btn.parentElement.querySelectorAll('.var.miss')].map(x => x.textContent))];
    const okN = btn.parentElement.querySelectorAll('.var.ok').length;
    toast('Código copiado (' + plural(text.split('\n').length, 'linha', 'linhas') + ')' +
          (miss.length ? ' · sem valor: ' + miss.join(', ') : okN ? ' · ' + plural(okN, 'variável substituída', 'variáveis substituídas') + (btn.parentElement.querySelector('.var.secret') ? ' (inclui segredo)' : '') : ''), miss.length ? 3600 : 0);
  } else copyFail();
});

pvIn.addEventListener('click', e => {
  const a = e.target.closest('a[href]'); if (!a) return;
  e.preventDefault();
  const href = a.getAttribute('href');
  if (!/^(https?:|mailto:)/i.test(href)) return;
  if (invoke) invoke('plugin:opener|open_url', { url: href }).catch(() => toast('Não foi possível abrir o link'));
  else window.open(href, '_blank', 'noopener');
});

/* Rolagem sincronizada: cada bloco do preview sabe de qual linha veio;
   entre dois blocos, a posição é interpolada. */
let syncLock = null, syncT;
function lock(who){ syncLock = who; clearTimeout(syncT); syncT = setTimeout(() => { syncLock = null; }, 90); }
function syncFromEditor(){
  if (mode !== 'split' || syncLock === 'preview' || !pvBlocks.length) return;
  const sc = editor.scroller;
  if (sc.scrollTop <= 0) { lock('editor'); pv.scrollTop = 0; return; }
  if (sc.scrollTop + sc.clientHeight >= sc.scrollHeight - 2) { lock('editor'); pv.scrollTop = pv.scrollHeight; return; }
  const lineF = editor.lineF();
  const idx = pvIndexForLine(lineF);
  let target;
  if (idx < 0) {
    target = pvBlocks[0].el.offsetTop * (lineF / Math.max(1, pvBlocks[0].line));
  } else {
    const a = pvBlocks[idx], b = pvBlocks[idx + 1];
    const aTop = a.el.offsetTop, bTop = b ? b.el.offsetTop : pv.scrollHeight;
    const bLine = b ? b.line : lines.length;
    const frac = bLine > a.line ? Math.min(1, Math.max(0, (lineF - a.line) / (bLine - a.line))) : 0;
    target = aTop + frac * (bTop - aTop);
  }
  lock('editor');
  pv.scrollTop = target - PV_PAD;
}
function syncFromPreview(){
  if (mode !== 'split' || syncLock === 'editor' || !pvBlocks.length) return;
  if (pv.scrollTop <= 0) { lock('preview'); editor.scroller.scrollTop = 0; return; }
  if (pv.scrollTop + pv.clientHeight >= pv.scrollHeight - 2) { lock('preview'); editor.scroller.scrollTop = editor.scroller.scrollHeight; return; }
  const y = pv.scrollTop + PV_PAD;
  let idx = -1;
  for (let i = 0; i < pvBlocks.length; i++) { if (pvBlocks[i].el.offsetTop <= y) idx = i; else break; }
  let lineF;
  if (idx < 0) lineF = pvBlocks[0].line * (y / Math.max(1, pvBlocks[0].el.offsetTop));
  else {
    const a = pvBlocks[idx], b = pvBlocks[idx + 1];
    const aTop = a.el.offsetTop, bTop = b ? b.el.offsetTop : pv.scrollHeight;
    const bLine = b ? b.line : lines.length;
    const frac = bTop > aTop ? Math.min(1, Math.max(0, (y - aTop) / (bTop - aTop))) : 0;
    lineF = a.line + frac * (bLine - a.line);
  }
  lock('preview');
  editor.scrollToLineF(lineF);
}
pv.addEventListener('scroll', syncFromPreview);

/* ---------- Modo de visualização ---------- */
const MODES = ['editor', 'split', 'preview'];
const MODE_LABEL = { editor: 'Só editor', split: 'Editor e preview lado a lado', preview: 'Só preview' };
function setMode(m, announce){
  mode = m;
  panes.dataset.mode = m;
  document.querySelectorAll('.seg button').forEach(b => b.setAttribute('aria-pressed', b.dataset.mode === m));
  if (state.viewMode !== m) { state.viewMode = m; markUiDirty(); }
  if (m !== 'editor') renderPreview();
  if (m !== 'preview' && cur()) editor.focus();
  if (announce) toast(MODE_LABEL[m]);
}
document.querySelectorAll('.seg button').forEach(b => b.addEventListener('click', () => setMode(b.dataset.mode)));

/* ---------- Gravar ao sair ---------- */
window.addEventListener('blur', () => { if (dirtyTabs.size || uiDirty) flush(); });
document.addEventListener('visibilitychange', () => { if (document.hidden && (dirtyTabs.size || uiDirty)) flush(); });

/* ---------- Modais ----------
   Um modal genérico: título, descrição, corpo dinâmico (#mBody), erro e
   botões (#mDanger aparece só quando o modo tem uma ação destrutiva). */
const modal = $('modal'), mBody = $('mBody'), mErr = $('mErr'), mOk = $('mOk'), mDanger = $('mDanger');
let M = null; // { mode, tabId, projectId, color }
const SW_CHECK = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3 8.5l3.2 3L13 4.5"/></svg>';
const nextColor = () => {
  const used = new Set(state.projects.map(p => p.color));
  return (PALETTE.find(c => !used.has(c[0])) || PALETTE[state.projects.length % PALETTE.length])[0];
};
const nameField = (label, value, ph) =>
  '<label class="f-label" for="fName">' + label + '</label><input id="fName" maxlength="' + MAX_NAME + '" autocomplete="off" placeholder="' + esc(ph || '') + '" value="' + esc(value || '') + '">';
const projectField = (sel, allowNew) =>
  '<label class="f-label" for="fProj">Projeto</label><select id="fProj"><option value="">Sem projeto</option>' +
  state.projects.map(p => '<option value="' + p.id + '"' + (p.id === sel ? ' selected' : '') + '>' + esc(p.name) + '</option>').join('') +
  (allowNew ? '<option value="__new">+ Novo projeto…</option>' : '') + '</select>';
const projectFields = (boxed, hidden, name) =>
  '<div' + (boxed ? ' class="np" id="npBox"' + (hidden ? ' hidden' : '') : '') + '>' +
  '<label class="f-label" for="fPName">Nome do projeto</label><input id="fPName" maxlength="' + MAX_NAME + '" autocomplete="off" placeholder="Ex.: CleanDev" value="' + esc(name || '') + '">' +
  '<div class="f-label" id="fColorsLbl">Cor</div><div class="swatches" id="fColors" role="radiogroup" aria-labelledby="fColorsLbl"></div>' +
  '<div class="sig-prev">Sigla nas abas: <span class="sig" id="fSig"></span></div></div>';

function renderSwatches(){
  const g = $('fColors'); if (!g) return;
  g.innerHTML = PALETTE.map(c => '<button type="button" class="sw" role="radio" data-c="' + c[0] + '" aria-checked="' + (M.color === c[0]) +
    '" aria-label="' + c[1] + '" title="' + c[1] + '" tabindex="' + (M.color === c[0] ? 0 : -1) + '" style="--pc:var(--pc-' + c[0] + ')">' + SW_CHECK + '</button>').join('');
  updateSig();
}
function updateSig(){
  const el = $('fSig'); if (!el) return;
  const name = normName(($('fPName') || {}).value || '');
  el.setAttribute('style', pcStyle(M.color));
  el.textContent = name ? initials(name) : '··';
}
function pickColor(c, focus){
  M.color = c; renderSwatches();
  if (focus) $('fColors').querySelector('[data-c="' + c + '"]').focus();
}
mBody.addEventListener('click', e => {
  if (M && M.mode === 'envs' && envClick(e)) return;
  const b = e.target.closest('.sw'); if (b) pickColor(b.dataset.c, true);
  const r = e.target.closest('[data-restore]'); if (r) restoreFromTrash(r.dataset.restore);
  const id = e.target.id;
  if (id === 'sPick') pickNotesDir();
  else if (id === 'sDefault') changeNotesDir(M.settings.defaultDir);
  else if (id === 'sRec') startCapture();
  else if (id === 'sKeyDefault') changeShortcut(M.settings.defaultShortcut);
  else if (id === 'sTour') { closeModal(); startTour(); }
});
mBody.addEventListener('change', e => {
  if (e.target.id === 'sAuto') toggleAutostart(e.target);
  if (e.target.id === 'sCodeHl') toggleCodeHl(e.target.checked);
});
mBody.addEventListener('keydown', e => {
  const b = e.target.closest('.sw');
  if (b) {
    const ids = PALETTE.map(c => c[0]), i = ids.indexOf(b.dataset.c);
    const d = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }[e.key];
    if (d) { e.preventDefault(); pickColor(ids[(i + d + ids.length) % ids.length], true); }
    return;
  }
  if (e.key === 'Enter' && e.target.tagName === 'INPUT' && M && M.mode !== 'envs') { e.preventDefault(); confirmModal(); }
});
mBody.addEventListener('input', e => {
  mErr.textContent = '';
  if (M && M.mode === 'envs' && envInput(e)) return;
  if (e.target.id === 'fPName') updateSig();
});
mBody.addEventListener('change', e => {
  if (e.target.id !== 'fProj') return;
  const nw = e.target.value === '__new';
  $('npBox').hidden = !nw;
  if (nw) { renderSwatches(); $('fPName').focus(); }
});

function openModal(m, id){
  closeProjMenu(); closeCtx(); closeEnvMenu();
  const tabModes = ['rename', 'move', 'close'];
  const t = tabModes.includes(m) ? state.tabs.find(x => x.id === id) : null;
  const p = (m === 'project' || m === 'projectDelete') && id ? projectById(id) : null;
  if ((tabModes.includes(m) && !t) || (m === 'projectDelete' && !p)) return;
  M = { mode: m, tabId: t ? t.id : null, projectId: p ? p.id : null, color: p ? colorOf(p) : nextColor() };
  mErr.textContent = ''; mOk.className = 'btn primary'; mDanger.hidden = true;
  const wide = m === 'trash' || m === 'settings';
  $('mCancel').hidden = wide || m === 'envs';
  modal.firstElementChild.classList.toggle('wide', wide); modal.firstElementChild.classList.toggle('xwide', m === 'envs');
  if (m === 'new') {
    $('mTitle').textContent = 'Nova aba';
    $('mDesc').textContent = 'Dê um nome que ajude você a encontrar essas anotações depois. O nome só precisa ser único dentro do projeto.';
    mBody.innerHTML = nameField('Nome da aba', '', 'Ex.: Anotações AWS') +
      projectField(projectById(state.filter) ? state.filter : '', true) + projectFields(true, true);
    mOk.textContent = 'Criar aba';
  } else if (m === 'rename') {
    $('mTitle').textContent = 'Renomear aba';
    $('mDesc').textContent = 'O novo nome aparece na aba e nos resultados da busca. O arquivo no disco acompanha o nome.';
    mBody.innerHTML = nameField('Nome da aba', t.name);
    mOk.textContent = 'Renomear';
  } else if (m === 'move') {
    $('mTitle').textContent = 'Mover “' + t.name + '” para um projeto';
    $('mDesc').textContent = 'O arquivo da aba muda de pasta. As anotações não são alteradas.';
    mBody.innerHTML = projectField(t.projectId || '', true) + projectFields(true, true);
    mOk.textContent = 'Mover';
  } else if (m === 'close') {
    $('mTitle').textContent = 'Fechar a aba “' + t.name + '”?';
    $('mDesc').textContent = 'A aba vai para a lixeira, de onde você pode restaurá-la com todo o conteúdo.';
    mBody.innerHTML = '';
    mOk.textContent = 'Fechar aba';
  } else if (m === 'project') {
    $('mTitle').textContent = p ? 'Editar projeto' : 'Novo projeto';
    $('mDesc').textContent = 'Projetos agrupam abas. O nome é único no app; a cor vem sempre acompanhada da sigla.';
    mBody.innerHTML = projectFields(false, false, p ? p.name : '');
    mOk.textContent = p ? 'Salvar' : 'Criar projeto';
    if (p) { mDanger.textContent = 'Excluir projeto'; mDanger.hidden = false; }
  } else if (m === 'envs') {
    $('mTitle').textContent = 'Ambientes e variáveis';
    $('mDesc').textContent = 'Use {{chave}} nas anotações. Ao copiar, o valor do ambiente ativo entra no lugar. A chave não diferencia maiúsculas de minúsculas.';
    M.envId = state.env || (state.envs[0] ? state.envs[0].id : null);
    mOk.textContent = 'Fechar';
  } else if (m === 'trash') {
    $('mTitle').textContent = 'Lixeira';
    $('mDesc').textContent = 'Abas fechadas ficam aqui até você restaurá-las ou esvaziar a lixeira.';
    mBody.innerHTML = '<div class="trash-list" id="trashList"></div>';
    mOk.textContent = 'Fechar';
  } else if (m === 'trashEmpty') {
    $('mTitle').textContent = 'Esvaziar a lixeira?';
    $('mDesc').textContent = 'Todas as abas da lixeira serão apagadas de vez. Essa ação não pode ser desfeita.';
    mBody.innerHTML = '';
    mOk.textContent = 'Esvaziar lixeira'; mOk.className = 'btn danger';
  } else if (m === 'settings') {
    $('mTitle').textContent = 'Configurações';
    $('mDesc').textContent = '';
    mBody.innerHTML = '';
    mOk.textContent = 'Fechar';
  } else {
    const n = state.tabs.filter(x => x.projectId === p.id).length;
    $('mTitle').textContent = 'Excluir o projeto “' + p.name + '”?';
    $('mDesc').textContent = n
      ? 'Nada será apagado: ' + plural(n, 'aba vai', 'abas vão') + ' para “Sem projeto”. Se algum nome já existir lá, o nome do projeto é acrescentado ao da aba.'
      : 'O projeto não tem abas. Nenhuma anotação será apagada.';
    mBody.innerHTML = '';
    mOk.textContent = 'Excluir projeto'; mOk.className = 'btn danger';
  }
  if (m === 'envs') renderEnvEditor();
  renderSwatches();
  modal.hidden = false;
  setTimeout(() => {
    const f = mBody.querySelector('#fName, #fPName');
    if (f) { f.focus(); f.select(); } else ($('mCancel').hidden ? mOk : $('mCancel')).focus();
  }, 0);
}
function closeModal(){
  const wasEnvs = !!M && M.mode === 'envs';
  modal.hidden = true; M = null; stopCapture();
  if (wasEnvs) finishEnvEdit();
  if (cur() && mode !== 'preview') editor.focus();
}
function fieldErr(msg, el){ mErr.textContent = msg; if (el) el.focus(); }
const tabNameError = name => !name ? 'Informe um nome para a aba.' : name.length > MAX_NAME ? 'O nome pode ter no máximo ' + MAX_NAME + ' caracteres.' : '';
const projectNameError = (name, exceptId) => !name ? 'Informe um nome para o projeto.'
  : name.length > MAX_NAME ? 'O nome pode ter no máximo ' + MAX_NAME + ' caracteres.'
  : projectNameTaken(name, exceptId) ? 'Já existe um projeto com esse nome.' : '';
const dupTabMsg = pid => 'Já existe uma aba com esse nome em “' + (pid ? projectById(pid).name : 'Sem projeto') + '”.';

function confirmModal(){
  const m = M; if (!m) return;
  if (m.mode === 'close') { closeModal(); closeTab(m.tabId); return; }
  if (m.mode === 'projectDelete') { closeModal(); removeProject(m.projectId); return; }
  if (m.mode === 'trash' || m.mode === 'settings' || m.mode === 'envs') { closeModal(); return; }
  if (m.mode === 'trashEmpty') {
    closeModal();
    enqueue(() => api.emptyTrash(), 'Não foi possível esvaziar a lixeira').then(n => { if (n !== undefined) toast('Lixeira esvaziada'); });
    return;
  }
  if (m.mode === 'project') {
    const el = $('fPName'), name = normName(el.value), e = projectNameError(name, m.projectId);
    if (e) return fieldErr(e, el);
    closeModal();
    if (m.projectId) { editProject(projectById(m.projectId), name, m.color); toast('Projeto atualizado'); }
    else { const p = createProject(name, m.color); setFilter(p.id); toast('Projeto “' + name + '” criado'); }
    return;
  }
  const t = m.tabId ? state.tabs.find(x => x.id === m.tabId) : null;
  let name = t ? t.name : '';
  if (m.mode !== 'move') {
    const el = $('fName'); name = normName(el.value);
    const e = tabNameError(name); if (e) return fieldErr(e, el);
  }
  let pid = t ? (t.projectId || null) : null, create = null;
  if (m.mode !== 'rename') {
    const v = $('fProj').value;
    if (v === '__new') {
      const el = $('fPName'), pn = normName(el.value), e = projectNameError(pn, null);
      if (e) return fieldErr(e, el);
      create = { name: pn, color: m.color };
    } else pid = v || null;
  }
  if (!create && nameTaken(name, pid, t ? t.id : null)) return fieldErr(dupTabMsg(pid), $('fName') || $('fProj'));
  closeModal();
  const dest = create ? createProject(create.name, create.color).id : pid;
  if (m.mode === 'new') createTab(name, dest);
  else if (m.mode === 'rename') {
    if (name !== t.name) { editTab(t, name, t.projectId); toast('Aba renomeada para “' + name + '”'); }
  } else if (dest !== (t.projectId || null)) {
    editTab(t, t.name, dest);
    toast('Aba “' + t.name + '” movida para “' + filterLabel(dest || 'none') + '”');
  }
}
mOk.addEventListener('click', confirmModal);
mDanger.addEventListener('click', () => {
  if (!M) return;
  if (M.mode === 'project' && M.projectId) openModal('projectDelete', M.projectId);
  else if (M.mode === 'trash') openModal('trashEmpty');
});
$('mCancel').addEventListener('click', closeModal);
modal.addEventListener('mousedown', e => { if (e.target === modal) closeModal(); });
$('newTab').addEventListener('click', () => openModal('new'));
$('emptyNew').addEventListener('click', () => openModal('new'));

/* ---------- Editor de ambientes e variáveis (modal) ----------
   Edição ao vivo, como no Postman: cada alteração entra no estado na hora e é gravada
   junto com o resto (flush). Linhas sem chave ficam só na tela; chave inválida ou
   repetida é marcada e não é gravada. */
const curEnv = () => state.envs.find(e => e.id === M.envId) || null;
const envNameError = (name, exceptId) => !name ? 'Informe um nome para o ambiente.'
  : name.length > MAX_NAME ? 'O nome pode ter no máximo ' + MAX_NAME + ' caracteres.'
  : state.envs.some(e => e.id !== exceptId && nameKey(e.name) === nameKey(name)) ? 'Já existe um ambiente com esse nome.' : '';
const uniqueEnvName = base => {
  let n = base, k = 2;
  while (state.envs.some(e => nameKey(e.name) === nameKey(n))) n = fitName(base, ' ' + k++);
  return n;
};
function envRowProblems(env){
  const seen = new Map(), bad = new Map();
  env.variables.forEach((v, i) => {
    if (!v.key && !v.value && !v.description) return;
    if (!v.key) { bad.set(i, 'Informe a chave da variável.'); return; }
    if (!validKey(v.key)) { bad.set(i, 'A chave “' + v.key + '” é inválida: use letras, números, _ . - (sem espaços).'); return; }
    const k = v.key.toLowerCase();
    if (seen.has(k)) bad.set(i, 'A chave “' + v.key + '” está repetida (maiúsculas e minúsculas contam como a mesma).');
    else seen.set(k, i);
  });
  return bad;
}
function validateEnv(nameErr){
  const env = curEnv(); if (!env) return;
  const bad = envRowProblems(env);
  mBody.querySelectorAll('.env-row:not(.hd)').forEach((row, i) => {
    row.querySelectorAll('input').forEach(inp => inp.classList.toggle('bad', bad.has(i) && (inp.dataset.f === 'key')));
  });
  const msg = $('envMsg');
  if (msg) msg.textContent = nameErr || [...bad.values()][0] || '';
}
function renderEnvEditor(){
  const env = curEnv();
  const side = '<div class="env-side">' + state.envs.map(e =>
    '<button class="env-pick" data-env="' + e.id + '"' + (env && e.id === env.id ? ' aria-current="true"' : '') + '><span>' + esc(e.name) + '</span><small>' +
    e.variables.filter(v => validKey(v.key)).length + '</small></button>').join('') +
    '<button class="env-pick env-add" id="envAdd">+ Novo ambiente</button></div>';
  let main;
  if (!env) {
    main = '<div class="env-main"><p>Nenhum ambiente ainda. Crie um (ex.: “Desenvolvimento”) para definir variáveis como HOST e usar {{host}} nas anotações.</p></div>';
  } else {
    main = '<div class="env-main"><div class="env-head"><input id="envName" maxlength="' + MAX_NAME + '" autocomplete="off" aria-label="Nome do ambiente" value="' + esc(env.name) + '">' +
      '<button class="btn" id="envDup">Duplicar</button><button class="btn danger-ghost" id="envDel">Excluir</button></div>' +
      '<div class="env-row hd"><span>Chave</span><span>Valor</span><span>Descrição</span><span>Segredo</span><span></span></div><div class="env-rows">' +
      (env.variables.length ? env.variables.map((v, i) =>
        '<div class="env-row"><input data-i="' + i + '" data-f="key" value="' + esc(v.key) + '" placeholder="HOST" autocomplete="off" spellcheck="false" aria-label="Chave">' +
        '<input data-i="' + i + '" data-f="value" type="' + (v.secret ? 'password' : 'text') + '" value="' + esc(v.value) + '" placeholder="' +
          (v.locked ? 'Cofre do sistema indisponível' : 'dev.cleandev.com.br') + '"' + (v.locked ? ' disabled' : '') + ' autocomplete="new-password" spellcheck="false" aria-label="Valor">' +
        '<input data-i="' + i + '" data-f="description" value="' + esc(v.description) + '" placeholder="Descrição (opcional)" autocomplete="off" aria-label="Descrição">' +
        '<span class="env-sec"><input type="checkbox" data-i="' + i + '" data-f="secret"' + (v.secret ? ' checked' : '') +
          (invoke ? '' : ' disabled') + ' aria-label="Segredo: guardar o valor no cofre do sistema" title="' +
          (invoke ? 'Segredo: o valor vai para o cofre do sistema e não é gravado no workspace.json' : 'O cofre do sistema só existe no aplicativo instalado') + '">' +
          '<button type="button" class="env-eye" data-eye="' + i + '"' + (v.secret ? '' : ' hidden') + ' aria-label="Mostrar ou ocultar o valor" title="Mostrar ou ocultar o valor">' +
          '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" aria-hidden="true"><path d="M1.5 8S4 3.5 8 3.5 14.5 8 14.5 8 12 12.5 8 12.5 1.5 8 1.5 8z"/><circle cx="8" cy="8" r="1.8"/></svg></button></span>' +
        '<button class="env-del" data-vdel="' + i + '" aria-label="Remover variável" title="Remover variável">&times;</button></div>').join('')
        : '<p class="env-note">Nenhuma variável neste ambiente.</p>') +
      '</div><button class="btn ghost" id="envVarAdd">+ Adicionar variável</button><div class="env-msg" id="envMsg" role="alert"></div>' +
      '<div class="env-note">Use <code>{{chave}}</code> nas anotações. Valores comuns ficam no workspace.json em texto puro. Marque <b>Segredo</b> para guardar o valor no cofre do sistema: ele não vai para nenhum arquivo, aparece como •••••• no preview e é copiado por inteiro. O cofre é deste computador; em outro, o segredo aparece sem valor.</div></div>';
  }
  mBody.innerHTML = '<div class="env-ed">' + side + main + '</div>';
  validateEnv();
}
function envClick(e){
  const t = e.target;
  const pick = t.closest('[data-env]');
  if (pick) { M.envId = pick.dataset.env; renderEnvEditor(); return true; }
  if (t.id === 'envAdd') {
    const env = { id: uid(), name: uniqueEnvName('Novo ambiente'), variables: [{ key: '', value: '', description: '', secret: false, locked: false }] };
    state.envs.push(env); M.envId = env.id;
    if (!state.env) { state.env = env.id; markUiDirty(); }
    markEnvDirty(); renderEnvEditor();
    const n = $('envName'); n.focus(); n.select();
    return true;
  }
  const env = curEnv(); if (!env) return false;
  if (t.id === 'envDup') {
    const copy = { id: uid(), name: uniqueEnvName(fitName(env.name, ' (cópia)')), variables: env.variables.map(v => ({ ...v })) };
    state.envs.push(copy); M.envId = copy.id; markEnvDirty(); renderEnvEditor();
    return true;
  }
  if (t.id === 'envDel') {
    if (!t.dataset.armed) {
      t.dataset.armed = '1'; t.textContent = 'Confirmar exclusão'; t.className = 'btn danger';
      setTimeout(() => { if (t.isConnected) { delete t.dataset.armed; t.textContent = 'Excluir'; t.className = 'btn danger-ghost'; } }, 3000);
      return true;
    }
    state.envs = state.envs.filter(x => x.id !== env.id);
    if (state.env === env.id) { state.env = null; markUiDirty(); }
    M.envId = state.envs[0] ? state.envs[0].id : null;
    markEnvDirty(); renderEnvEditor();
    toast('Ambiente “' + env.name + '” excluído');
    return true;
  }
  if (t.id === 'envVarAdd') {
    env.variables.push({ key: '', value: '', description: '', secret: false, locked: false });
    renderEnvEditor();
    const keys = mBody.querySelectorAll('input[data-f="key"]'); keys[keys.length - 1].focus();
    return true;
  }
  const eye = t.closest('[data-eye]');
  if (eye) {
    const inp = eye.closest('.env-row').querySelector('[data-f="value"]');
    inp.type = inp.type === 'password' ? 'text' : 'password';
    return true;
  }
  const del = t.closest('[data-vdel]');
  if (del) { env.variables.splice(+del.dataset.vdel, 1); markEnvDirty(); renderEnvEditor(); return true; }
  return false;
}
function envInput(e){
  const env = curEnv(); if (!env) return false;
  const t = e.target;
  if (t.dataset.f) {
    const v = env.variables[+t.dataset.i];
    if (t.type === 'checkbox') {
      v.secret = t.checked;
      const row = t.closest('.env-row');
      row.querySelector('[data-f="value"]').type = v.secret ? 'password' : 'text';
      row.querySelector('.env-eye').hidden = !v.secret;
    } else v[t.dataset.f] = t.value;
    markEnvDirty(); validateEnv();
    const cnt = mBody.querySelector('.env-pick[aria-current] small');
    if (cnt) cnt.textContent = new Set(env.variables.filter(v => validKey(v.key)).map(v => v.key.toLowerCase())).size;
    return true;
  }
  if (t.id === 'envName') {
    const name = normName(t.value), err = envNameError(name, env.id);
    if (!err) {
      env.name = name; markEnvDirty();
      const lab = mBody.querySelector('.env-pick[aria-current] span'); if (lab) lab.textContent = name;
    }
    validateEnv(err);
    return true;
  }
  return false;
}
/* Ao fechar: linhas vazias somem, linhas inválidas são descartadas (com aviso) e tudo é gravado. */
function finishEnvEdit(){
  let dropped = 0;
  state.envs.forEach(env => {
    const bad = envRowProblems(env);
    dropped += bad.size;
    env.variables = env.variables.filter((v, i) => (v.key || v.value || v.description) && !bad.has(i));
  });
  if (dropped) toast(plural(dropped, 'linha com chave inválida ou repetida não foi salva', 'linhas com chave inválida ou repetida não foram salvas'));
  markEnvDirty();
  renderChrome(); renderPreview(); editor.refreshVars();
  flush();
}

/* ---------- Lixeira ---------- */
async function openTrash(){ openModal('trash'); await renderTrash(); }
async function renderTrash(){
  const list = $('trashList'); if (!list) return;
  let items;
  try { items = await run(() => api.listTrash()); }
  catch (e) { list.textContent = 'Não foi possível ler a lixeira: ' + e; return; }
  if (!M || M.mode !== 'trash') return;
  mDanger.textContent = 'Esvaziar lixeira'; mDanger.hidden = !items.length;
  list.innerHTML = items.length ? items.map(it => {
    const chip = it.projectName ? sigHtml({ name: it.projectName, color: it.projectColor }) : '';
    const when = new Date(it.deletedAt * 1000).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' });
    return '<div class="trash-item"><div class="trash-info"><div class="trash-name">' + chip + '<span>' + esc(it.name) + '</span></div>' +
           '<div class="trash-meta">' + esc(it.projectName || 'Sem projeto') + ' · fechada em ' + when + '</div></div>' +
           '<button class="btn" data-restore="' + esc(it.id) + '">Restaurar</button></div>';
  }).join('') : '<div class="trash-empty">A lixeira está vazia.</div>';
}
async function restoreFromTrash(id){
  const res = await enqueue(() => api.restoreTrash(id), 'Não foi possível restaurar a aba');
  if (res) {
    const t = { id: res.id, name: res.name, projectId: res.projectId || null, file: res.file || '', content: res.content };
    saveView();
    state.tabs.push(t);
    if (!inFilter(t)) state.filter = t.projectId || 'none';
    setActive(t.id);
    loadEditor(); renderTabs();
    toast('Aba “' + t.name + '” restaurada');
  }
  renderTrash();
}

/* ---------- Exportar e importar .md ---------- */
const dlg = window.__TAURI__ && window.__TAURI__.dialog ? window.__TAURI__.dialog : null;
const safeFile = n => n.replace(/[\\/:*?"<>|]+/g, '-').trim() || 'nota';
async function exportTab(id){
  const t = state.tabs.find(x => x.id === id); if (!t) return;
  if (!invoke) {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([t.content], { type: 'text/markdown' })); a.download = safeFile(t.name) + '.md'; a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    toast('Aba “' + t.name + '” exportada'); return;
  }
  try {
    const path = await dlg.save({ title: 'Exportar aba como .md', defaultPath: safeFile(t.name) + '.md', filters: [{ name: 'Markdown', extensions: ['md'] }] });
    if (!path) return;
    await flush();
    const out = await run(() => invoke('export_tab', { id, path }));
    toast('Aba exportada para ' + out);
  } catch (e) { toast('Não foi possível exportar: ' + e); }
}
function pickMd(){
  if (invoke) return dlg.open({ title: 'Importar arquivo .md', multiple: false, directory: false, filters: [{ name: 'Markdown', extensions: ['md', 'markdown', 'txt'] }] });
  return new Promise(resolve => {
    const inp = document.createElement('input'); inp.type = 'file'; inp.accept = '.md,.markdown,.txt,text/markdown,text/plain';
    inp.onchange = async () => { const f = inp.files[0]; resolve(f ? { name: f.name.replace(/\.[^.]+$/, ''), content: await f.text() } : null); };
    inp.click();
  });
}
async function importTab(){
  let picked;
  try { picked = await pickMd(); } catch (e) { toast('Não foi possível abrir o seletor de arquivos: ' + e); return; }
  if (!picked) return;
  const id = uid(), pid = projectById(state.filter) ? state.filter : null;
  const res = await enqueue(() => api.importTab(id, picked, pid), 'Não foi possível importar');
  if (!res) return;
  const t = { id: res.id, name: res.name, projectId: res.projectId || null, file: res.file || '', content: res.content };
  saveView();
  state.tabs.push(t);
  if (!inFilter(t)) state.filter = t.projectId || 'none';
  setActive(t.id);
  loadEditor(); renderTabs();
  toast('Aba “' + t.name + '” importada');
}
$('importTab').addEventListener('click', importTab);
$('trashBtn').addEventListener('click', openTrash);

/* ---------- Configurações: pasta das notas, atalho global, início com o sistema ---------- */
const prettyShortcut = sc => sc.split('+').map(p => ({ CommandOrControl: 'Ctrl', CommandOrCtrl: 'Ctrl', CmdOrControl: 'Ctrl', CmdOrCtrl: 'Ctrl', Space: 'Espaço', Super: 'Win' }[p] || p)).join('+');
async function openSettings(){ openModal('settings'); await renderSettings(); }
const helpSection = () =>
  '<div class="set-sec"><h3>Ajuda</h3><p>Um tour curto pelos recursos principais. Também abre com o botão <b>?</b> da barra de cima ou com <kbd>F1</kbd>.</p>' +
  '<button class="btn" id="sTour">Rever o tour de primeiros passos</button></div>';
const editorSection = () =>
  '<div class="set-sec"><h3>Editor</h3><label class="set-check"><input type="checkbox" id="sCodeHl"' + (codeHl ? ' checked' : '') +
  '> Realçar a sintaxe dentro dos blocos de código (bash, sql, json, yaml, java)</label>' +
  '<p class="set-hint">Desligado, o código aparece numa cor só; ligado, ganha as mesmas cores do preview. Vale pela linguagem da cerca (```bash).</p></div>';
function toggleCodeHl(on){
  codeHl = on;
  try { localStorage.setItem(CODEHL_KEY, on ? '1' : '0'); } catch (e) {}
  editor.refreshCode();
}
async function renderSettings(){
  if (!invoke) {
    mBody.innerHTML = editorSection() + helpSection() +
      '<div class="set-sec"><p>Pasta das notas, atalho global e início com o sistema só existem no aplicativo instalado. Aberto direto no navegador, o CleanNotes guarda tudo no localStorage.</p></div>';
    return;
  }
  let s, auto = false;
  try { s = await invoke('get_settings'); } catch (e) { mBody.textContent = 'Não foi possível ler as configurações: ' + e; return; }
  try { auto = await invoke('plugin:autostart|is_enabled'); } catch (e) {}
  if (!M || M.mode !== 'settings') return;
  M.settings = s;
  mBody.innerHTML =
    '<div class="set-sec"><h3>Pasta das notas</h3><p>As notas são arquivos .md comuns. Aponte para uma pasta do OneDrive, Dropbox ou de um repositório Git para sincronizar ou versionar.</p>' +
    '<div class="set-path">' + esc(s.notesDir) + '</div><div class="set-row"><button class="btn" id="sPick">Escolher pasta…</button>' +
    (s.notesDir !== s.defaultDir ? '<button class="btn ghost" id="sDefault">Usar a pasta padrão</button>' : '') + '</div>' +
    '<label class="set-check"><input type="checkbox" id="sMove" checked> Mover as notas existentes para a nova pasta</label></div>' +
    '<div class="set-sec"><h3>Atalho global</h3><p>Mostra o CleanNotes por cima de tudo e foca o editor, mesmo com o app minimizado.</p>' +
    '<div class="set-row"><span class="set-key" id="sKey">' + esc(prettyShortcut(s.shortcut)) + '</span><button class="btn" id="sRec">Alterar</button>' +
    (s.shortcut !== s.defaultShortcut ? '<button class="btn ghost" id="sKeyDefault">Restaurar padrão</button>' : '') + '</div>' +
    (s.shortcutError ? '<div class="set-warn">' + esc(s.shortcutError) + ' Escolha outro atalho.</div>' : '') + '</div>' +
    '<div class="set-sec"><h3>Início</h3><label class="set-check"><input type="checkbox" id="sAuto"' + (auto ? ' checked' : '') +
    '> Iniciar com o sistema (abre escondido, na bandeja)</label></div>' + editorSection() + helpSection();
}
async function pickNotesDir(){
  try {
    const dir = await dlg.open({ title: 'Escolher a pasta das notas', directory: true, multiple: false });
    if (dir) changeNotesDir(dir);
  } catch (e) { mErr.textContent = 'Não foi possível abrir o seletor de pastas: ' + e; }
}
async function changeNotesDir(path){
  mErr.textContent = '';
  const move = $('sMove') ? $('sMove').checked : false;
  try {
    await flush();
    await run(() => invoke('set_notes_dir', { path, moveExisting: move }));
  } catch (e) { mErr.textContent = String(e); return; }
  reloading = true;
  toast('Pasta das notas alterada');
  setTimeout(() => location.reload(), 400);
}
async function changeShortcut(sc){
  mErr.textContent = '';
  try { await run(() => invoke('set_shortcut', { shortcut: sc })); toast('Atalho global: ' + prettyShortcut(sc)); }
  catch (e) { mErr.textContent = String(e); }
  if (M && M.mode === 'settings') renderSettings();
}
async function toggleAutostart(box){
  mErr.textContent = '';
  try { await invoke('plugin:autostart|' + (box.checked ? 'enable' : 'disable')); }
  catch (e) { box.checked = !box.checked; mErr.textContent = 'Não foi possível alterar o início com o sistema: ' + e; }
}
/* Captura a combinação de teclas para o atalho global (letra, número, F1-F24 ou Espaço + modificador). */
let capturing = null;
function stopCapture(){
  if (!capturing) return;
  document.removeEventListener('keydown', capturing, true); capturing = null;
  const k = $('sKey'); if (k) { k.classList.remove('rec'); if (M && M.settings) k.textContent = prettyShortcut(M.settings.shortcut); }
}
function startCapture(){
  stopCapture(); mErr.textContent = '';
  const k = $('sKey'); k.classList.add('rec'); k.textContent = 'Pressione as teclas… (Esc cancela)';
  capturing = ev => {
    ev.preventDefault(); ev.stopImmediatePropagation();
    if (ev.key === 'Escape') { stopCapture(); return; }
    if (['Control', 'Shift', 'Alt', 'Meta', 'AltGraph'].includes(ev.key)) return;
    const c = ev.code;
    const key = /^Key[A-Z]$/.test(c) ? c.slice(3) : /^Digit\d$/.test(c) ? c.slice(5) : /^F([1-9]|1\d|2[0-4])$/.test(c) ? c : c === 'Space' ? 'Space' : null;
    if (!key) { mErr.textContent = 'Use uma letra, número, F1 a F24 ou Espaço.'; return; }
    const mods = [];
    if (ev.ctrlKey) mods.push('Ctrl'); if (ev.altKey) mods.push('Alt'); if (ev.shiftKey) mods.push('Shift'); if (ev.metaKey) mods.push('Super');
    if (!mods.length) { mErr.textContent = 'Inclua Ctrl, Alt, Shift ou Win junto com a tecla.'; return; }
    stopCapture(); changeShortcut(mods.concat(key).join('+'));
  };
  document.addEventListener('keydown', capturing, true);
}
$('settingsBtn').addEventListener('click', openSettings);

/* ---------- Busca (em todos os projetos) ---------- */
const q = $('q'), results = $('results');
let resItems = [], resSel = 0;
function runSearch(){
  const term = q.value.trim().toLowerCase();
  if (term.length < 2) { results.hidden = true; return; }
  resItems = [];
  for (const t of state.tabs) {
    const ls = t.content.split('\n');
    for (let i = 0; i < ls.length && resItems.length < 40; i++) {
      const idx = ls[i].toLowerCase().indexOf(term);
      if (idx >= 0) resItems.push({ tab: t, line: i, text: ls[i], idx, len: term.length });
    }
  }
  resSel = 0;
  if (!resItems.length) {
    results.innerHTML = '<div class="res-empty">Nada encontrado para “' + esc(q.value.trim()) + '”.</div>';
  } else {
    results.innerHTML = resItems.map((r, n) => {
      const start = Math.max(0, r.idx - 30);
      const pre = (start > 0 ? '…' : '') + r.text.slice(start, r.idx);
      const snip = esc(pre) + '<mark>' + esc(r.text.substr(r.idx, r.len)) + '</mark>' + esc(r.text.slice(r.idx + r.len, r.idx + r.len + 60));
      const p = tabProject(r.tab);
      return '<button class="res' + (n === 0 ? ' sel' : '') + '" role="option" data-n="' + n + '"><span class="res-tab">' +
             (p ? sigHtml(p) : '') + '<span>' + esc(r.tab.name) + '</span>' + (p ? '<span class="res-proj">' + esc(p.name) + '</span>' : '') +
             '</span><span class="res-ln">linha ' + (r.line + 1) + '</span><code>' + snip + '</code></button>';
    }).join('');
  }
  results.hidden = false;
}
function moveSel(d){
  if (!resItems.length) return;
  resSel = (resSel + d + resItems.length) % resItems.length;
  results.querySelectorAll('.res').forEach((el, n) => el.classList.toggle('sel', n === resSel));
  const el = results.querySelector('.res.sel'); if (el) el.scrollIntoView({ block: 'nearest' });
}
function jump(tabId, line){
  results.hidden = true;
  const t = state.tabs.find(x => x.id === tabId); if (!t) return;
  if (!inFilter(t)) setFilter(t.projectId || 'none');
  if (tabId !== state.active) switchTab(tabId);
  if (mode === 'preview') setMode('split');
  editor.focus();
  editor.selectLine(line);
  flash(line, line);
}
q.addEventListener('input', runSearch);
q.addEventListener('focus', runSearch);
q.addEventListener('keydown', e => {
  if (e.key === 'ArrowDown') { e.preventDefault(); moveSel(1); }
  if (e.key === 'ArrowUp') { e.preventDefault(); moveSel(-1); }
  if (e.key === 'Enter' && resItems[resSel] && !results.hidden) { e.preventDefault(); const r = resItems[resSel]; jump(r.tab.id, r.line); }
  if (e.key === 'Escape') { results.hidden = true; q.blur(); if (cur() && mode !== 'preview') editor.focus(); }
});
results.addEventListener('mousedown', e => e.preventDefault());
results.addEventListener('click', e => {
  const b = e.target.closest('.res'); if (!b) return;
  const r = resItems[+b.dataset.n]; jump(r.tab.id, r.line);
});
q.addEventListener('blur', () => { results.hidden = true; });

/* ---------- Atalhos globais e toast ---------- */
document.addEventListener('keydown', e => {
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); q.focus(); q.select(); }
  if (e.altKey && !e.ctrlKey && !e.metaKey && modal.hidden) {
    if (e.code === 'KeyN') { e.preventDefault(); openModal('new'); }
    if (e.code === 'KeyE') { e.preventDefault(); openEnvMenu(); }
    if (e.code === 'KeyP') { e.preventDefault(); setMode(MODES[(MODES.indexOf(mode) + 1) % MODES.length], true); }
    const d = /^Digit([0-9])$/.exec(e.code);
    if (d) {
      const n = +d[1];
      if (n === 0) { e.preventDefault(); setFilter('all'); }
      else if (state.projects[n - 1]) { e.preventDefault(); setFilter(state.projects[n - 1].id); }
    }
  }
  if (e.key === 'F1' && modal.hidden) { e.preventDefault(); startTour(); }
  if (e.key === 'F2' && !e.altKey && !e.ctrlKey && !e.metaKey && modal.hidden && cur()) { e.preventDefault(); openModal('rename', state.active); }
  if (e.key === 'Escape' && !modal.hidden) closeModal();
});
let toastT;
function toast(msg, ms){
  const el = $('toast'); el.textContent = msg; el.classList.add('show');
  clearTimeout(toastT); toastT = setTimeout(() => el.classList.remove('show'), ms || 1600);
}

/* ---------- Tour de primeiros passos ----------
   Abre sozinho na primeira abertura (quando as notas de exemplo são criadas) e depois só pelo botão ?,
   por F1 ou em Configurações > Ajuda. Os passos explicam o que cada parte da tela faz. */
const TOUR_KEY = 'cleannotes:tour';
const tourSeen = () => { try { return localStorage.getItem(TOUR_KEY) === 'done'; } catch (e) { return false; } };
const markTourSeen = () => { try { localStorage.setItem(TOUR_KEY, 'done'); } catch (e) {} };
let tourPrevMode = null;
/* No exemplo, a linha "git status" mostra o botão de copiar por linha; se ela não existir, a primeira linha copiável serve. */
const tourLine = () => {
  const i = lines.findIndex((l, n) => /^git status/.test(l) && B.isCopyableLine(lines, lineKind, n));
  return i >= 0 ? i : lines.findIndex((l, n) => B.isCopyableLine(lines, lineKind, n));
};
const TOUR_STEPS = [
  { title: 'Bem-vindo ao CleanNotes', text: 'Um tour de <b>1 minuto</b> pelos recursos principais. Use <kbd>→</kbd> e <kbd>←</kbd> para navegar ou <kbd>Esc</kbd> para pular.<br><br>Para rever depois: botão <b>?</b> na barra de cima ou <kbd>F1</kbd>.' },
  { target: '.tab-row', placement: 'bottom', title: 'Abas',
    text: 'Cada aba é uma nota, guardada como um arquivo <code>.md</code> comum. A aba <b>Bem-vindo</b> traz exemplos de cada recurso.<br><br>Crie outra com <b>+</b> ou <kbd>Alt N</kbd>; clique duas vezes para renomear; importe um <code>.md</code> pelo botão ao lado do +.' },
  { target: '#projBtn', placement: 'bottom', title: 'Projetos',
    text: 'Agrupe abas em <b>projetos</b>, cada um com nome, cor e sigla. Escolha aqui o filtro (Todos, um projeto ou Sem projeto) e crie o primeiro em <b>+ Novo projeto</b>.<br><br>Atalhos: <kbd>Alt 0</kbd> a <kbd>Alt 9</kbd>.' },
  { target: '#editor', placement: 'right', title: 'Editor Markdown',
    text: 'Escreva aqui em Markdown. O editor tem numeração, <b>dobrar</b> seções e blocos (setas ao lado dos números), <b>buscar e substituir</b> (<kbd>Ctrl F</kbd>), <b>desfazer</b> separado por aba (<kbd>Ctrl Z</kbd>) e vários cursores (<kbd>Alt</kbd>+clique).' },
  { target: () => document.querySelector('.cm-blockgutter .blk-btn'), placement: 'right', title: 'Copiar um bloco',
    before: () => { editor.scroller.scrollTop = 0; },
    text: 'Cada bloco tem um botão de copiar no colchete à esquerda. Num bloco de código, <b>só o conteúdo</b> é copiado, sem as cercas de crase.<br><br>Atalho: <kbd>Alt B</kbd> com o cursor no bloco.' },
  { target: () => document.querySelector('.cm-copycol .cp'), placement: 'right', title: 'Copiar uma linha',
    before: () => { const i = tourLine(); if (i >= 0) editor.placeCaret(i); },
    text: 'Na linha do cursor (e na que está sob o mouse), o botão da coluna da direita copia <b>só aquela linha</b>, de texto ou de código.<br><br>Atalho: <kbd>Alt C</kbd>.' },
  { target: '.seg', placement: 'bottom', title: 'Editor, lado a lado e preview',
    text: 'Alterne a visualização aqui ou com <kbd>Alt P</kbd>. No preview os blocos de código também têm botão de copiar, e rolar um lado rola o outro.' },
  { target: '#envBtn', placement: 'bottom', title: 'Ambientes e variáveis',
    text: 'Como no Postman: defina variáveis (ex.: <code>HOST</code>) por ambiente (Desenvolvimento, Produção…) e escreva <code>{{host}}</code> na nota. Ao copiar, entra o valor do ambiente ativo.<br><br>Para senhas, marque <b>Segredo</b>: o valor vai para o cofre do sistema, não para o arquivo. Atalho: <kbd>Alt E</kbd>.' },
  { target: '#q', placement: 'bottom', title: 'Busca em tudo',
    text: '<kbd>Ctrl K</kbd> procura em todas as abas e projetos e leva você direto à linha do resultado.' },
  { target: '#trashBtn', placement: 'bottom', title: 'Lixeira',
    text: 'Fechar uma aba não apaga de vez: ela vai para a lixeira e pode ser restaurada com o conteúdo intacto.' },
  { target: '#settingsBtn', placement: 'bottom', title: 'Configurações',
    text: 'Escolha a <b>pasta das notas</b> (OneDrive, Dropbox, um repositório Git…), o <b>atalho global</b> (<kbd>Ctrl Shift Espaço</kbd> traz o app por cima de tudo), o início com o sistema e o realce de código no editor.' },
  { title: 'Tudo pronto!', text: 'Crie sua primeira aba com <b>+</b> (<kbd>Alt N</kbd>). Quando não precisar mais da aba de boas-vindas, feche-a: ela vai para a lixeira.<br><br>Para rever este tour: botão <b>?</b> ou <kbd>F1</kbd>.' }
];
const tour = createTour({
  steps: TOUR_STEPS,
  onClose: () => {
    markTourSeen();
    if (tourPrevMode && tourPrevMode !== mode) setMode(tourPrevMode);
    tourPrevMode = null;
    if (cur()) editor.focus();
  }
});
function startTour(){
  if (tour.isRunning()) return;
  closeProjMenu(); closeEnvMenu(); closeCtx();
  if (!modal.hidden) closeModal();
  if (!state.tabs.length) { toast('Crie uma aba primeiro: o tour usa a tela com uma nota aberta'); return; }
  tourPrevMode = mode;
  if (mode !== 'split') setMode('split');
  tour.start();
}
$('helpBtn').addEventListener('click', startTour);

/* ---------- Início ---------- */
async function start(){
  let loaded = null, loadFailed = false, firstRun = false;
  try { loaded = await api.load(); }
  catch (e) { loadFailed = true; toast('Não foi possível abrir as anotações: ' + e); }
  if (loaded && Array.isArray(loaded.tabs)) {
    const ui = loaded.ui || {};
    state = {
      projects: Array.isArray(loaded.projects) ? loaded.projects : [],
      tabs: loaded.tabs.map(t => ({ ...t, projectId: t.projectId || null, file: t.file || '' })),
      active: ui.active || null, viewMode: ui.viewMode || 'split', filter: ui.filter || 'all',
      lastActive: ui.lastActive && typeof ui.lastActive === 'object' ? ui.lastActive : {},
      trash: Array.isArray(loaded.trash) ? loaded.trash : [],
      envs: (Array.isArray(loaded.environments) ? loaded.environments : []).map(e => ({
        id: e.id, name: e.name,
        variables: (e.variables || []).map(v => ({ key: v.key || '', value: v.value || '', description: v.description || '', secret: !!v.secret, locked: !!v.locked }))
      })),
      env: ui.env || null
    };
    if (loaded.dir) { wsDir = loaded.dir; $('saveState').title = 'Notas em ' + loaded.dir; }
  } else if (loadFailed) {
    /* Não semeamos exemplos por cima de um workspace que não conseguimos ler. */
    state = { projects: [], tabs: [], active: null, viewMode: 'split', filter: 'all', lastActive: {}, trash: [], envs: [], env: null };
  } else {
    state = seed();
    firstRun = true;
    state.projects.forEach(p => enqueue(() => api.createProject(p.id, p.name, p.color).then(f => { p.folder = f; }), 'Não foi possível criar o projeto'));
    state.tabs.forEach(t => {
      enqueue(() => api.createTab(t.id, t.name, t.projectId).then(f => { t.file = f; renderChrome(); }), 'Não foi possível criar a aba');
      dirtyTabs.add(t.id);
    });
    uiDirty = true; envDirty = true;
    flush();
  }
  if (!validFilter(state.filter)) state.filter = 'all';
  if (state.env && !activeEnv()) state.env = null;
  fixActive();
  mode = MODES.includes(state.viewMode) ? state.viewMode : 'split';
  panes.dataset.mode = mode;
  document.querySelectorAll('.seg button').forEach(b => b.setAttribute('aria-pressed', b.dataset.mode === mode));
  mdReady = setupMarkdown();
  renderTabs(); loadEditor();
  if (firstRun && !tourSeen()) setTimeout(startTour, 700);
  /* Eventos do backend: atalho global traz a janela e foca o editor; "Sair" da bandeja grava antes. */
  const tev = window.__TAURI__ && window.__TAURI__.event;
  if (tev) {
    tev.listen('focus-editor', () => {
      if (!modal.hidden) return;
      if (mode === 'preview') setMode('split');
      if (cur()) editor.focus();
    });
    tev.listen('quit-requested', async () => { await flush(); invoke('quit_app'); });
  }
  if (document.fonts && document.fonts.ready) document.fonts.ready.then(() => { editor.view.requestMeasure(); syncFromEditor(); });
}
start();
