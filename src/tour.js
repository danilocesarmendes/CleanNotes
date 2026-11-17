/* Tour guiado de primeiros passos: um holofote sobre o elemento da vez e um cartão explicando.

   Sem dependências e sem conhecer o app: recebe a lista de passos. Cada passo tem
     target     seletor CSS (ou função que devolve o elemento) a destacar; sem alvo visível,
                o cartão aparece no centro
     title/text texto do cartão (HTML escrito por nós, nunca vindo de nota)
     placement  onde preferir o cartão: 'bottom' | 'top' | 'left' | 'right'
     before     gancho opcional, chamado ao entrar no passo (ex.: posicionar o cursor)
   Teclado: → ou Enter avançam, ← volta, Esc pula. */

const PAD = 6;      // folga do holofote em volta do alvo
const GAP = 14;     // distância entre o alvo e o cartão
const MARGIN = 12;  // distância mínima entre o cartão e a borda da janela

const resolve = target => {
  const el = typeof target === 'function' ? target() : target ? document.querySelector(target) : null;
  if (!el) return null;
  const r = el.getBoundingClientRect();
  return r.width > 0 && r.height > 0 ? el : null;
};

export function createTour({ steps, onClose }) {
  let root, spot, card, titleEl, textEl, countEl, dotsEl, backBtn, nextBtn, skipBtn;
  let index = 0, running = false, prevFocus = null, raf = 0;

  function build() {
    root = document.createElement('div');
    root.className = 'tour';
    root.innerHTML =
      '<div class="tour-spot" aria-hidden="true"></div>' +
      '<div class="tour-card" role="dialog" aria-modal="true" aria-labelledby="tourTitle" aria-describedby="tourText" tabindex="-1">' +
        '<div class="tour-count"></div>' +
        '<h2 id="tourTitle"></h2>' +
        '<div class="tour-text" id="tourText"></div>' +
        '<div class="tour-dots" aria-hidden="true"></div>' +
        '<div class="tour-actions">' +
          '<button type="button" class="btn ghost tour-skip">Pular tour</button>' +
          '<span class="tour-spacer"></span>' +
          '<button type="button" class="btn tour-back">Voltar</button>' +
          '<button type="button" class="btn primary tour-next"></button>' +
        '</div>' +
      '</div>';
    document.body.append(root);
    spot = root.querySelector('.tour-spot');
    card = root.querySelector('.tour-card');
    titleEl = root.querySelector('#tourTitle');
    textEl = root.querySelector('#tourText');
    countEl = root.querySelector('.tour-count');
    dotsEl = root.querySelector('.tour-dots');
    backBtn = root.querySelector('.tour-back');
    nextBtn = root.querySelector('.tour-next');
    skipBtn = root.querySelector('.tour-skip');
    backBtn.addEventListener('click', () => go(index - 1));
    nextBtn.addEventListener('click', () => next());
    skipBtn.addEventListener('click', () => stop(false));
    // o fundo escuro não deixa clicar no app por baixo do tour
    root.addEventListener('mousedown', e => { if (e.target === root) e.preventDefault(); });
    dotsEl.innerHTML = steps.map(() => '<span></span>').join('');
  }

  function place() {
    const step = steps[index];
    const el = resolve(step.target);
    if (el) {
      const r = el.getBoundingClientRect();
      Object.assign(spot.style, {
        display: 'block', left: r.left - PAD + 'px', top: r.top - PAD + 'px',
        width: r.width + PAD * 2 + 'px', height: r.height + PAD * 2 + 'px'
      });
      root.classList.remove('centered');
    } else {
      spot.style.display = 'none';
      root.classList.add('centered');
    }
    const cw = card.offsetWidth, ch = card.offsetHeight, vw = window.innerWidth, vh = window.innerHeight;
    let left = (vw - cw) / 2, top = (vh - ch) / 2;
    if (el) {
      const r = el.getBoundingClientRect();
      const room = {
        bottom: vh - r.bottom - PAD - GAP, top: r.top - PAD - GAP,
        right: vw - r.right - PAD - GAP, left: r.left - PAD - GAP
      };
      const fits = { bottom: room.bottom >= ch, top: room.top >= ch, right: room.right >= cw, left: room.left >= cw };
      const order = [step.placement, 'bottom', 'top', 'right', 'left'].filter(Boolean);
      const side = order.find(s => fits[s]) || order.reduce((a, b) => (room[b] > room[a] ? b : a));
      if (side === 'bottom') { top = r.bottom + PAD + GAP; left = r.left + r.width / 2 - cw / 2; }
      else if (side === 'top') { top = r.top - PAD - GAP - ch; left = r.left + r.width / 2 - cw / 2; }
      else if (side === 'right') { left = r.right + PAD + GAP; top = r.top + r.height / 2 - ch / 2; }
      else { left = r.left - PAD - GAP - cw; top = r.top + r.height / 2 - ch / 2; }
    }
    card.style.left = Math.round(Math.min(Math.max(MARGIN, left), Math.max(MARGIN, vw - cw - MARGIN))) + 'px';
    card.style.top = Math.round(Math.min(Math.max(MARGIN, top), Math.max(MARGIN, vh - ch - MARGIN))) + 'px';
  }
  const schedulePlace = () => { cancelAnimationFrame(raf); raf = requestAnimationFrame(place); };

  function go(i) {
    index = Math.max(0, Math.min(steps.length - 1, i));
    const step = steps[index];
    if (step.before) step.before();
    const el = resolve(step.target);
    if (el) el.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    countEl.textContent = 'Passo ' + (index + 1) + ' de ' + steps.length;
    titleEl.textContent = step.title;
    textEl.innerHTML = step.text;
    backBtn.hidden = index === 0;
    nextBtn.textContent = index === steps.length - 1 ? 'Concluir' : 'Próximo';
    skipBtn.hidden = index === steps.length - 1;
    [...dotsEl.children].forEach((d, k) => d.classList.toggle('on', k === index));
    place();
    nextBtn.focus();
  }

  const next = () => (index === steps.length - 1 ? stop(true) : go(index + 1));

  function onKey(e) {
    if (!running) return;
    const onButton = e.target instanceof HTMLButtonElement;
    if (e.key === 'Escape') stop(false);
    else if (e.key === 'ArrowRight' || (e.key === 'Enter' && !onButton)) next();
    else if (e.key === 'ArrowLeft') go(index - 1);
    else if (e.key === 'Tab') {
      // mantém o foco dentro do cartão
      const items = [...card.querySelectorAll('button:not([hidden])')];
      const at = items.indexOf(document.activeElement);
      items[(at + (e.shiftKey ? -1 : 1) + items.length) % items.length].focus();
    } else return;
    e.preventDefault();
    e.stopImmediatePropagation();
  }

  function start() {
    if (running) return;
    if (!root) build();
    running = true;
    prevFocus = document.activeElement;
    root.hidden = false;
    document.addEventListener('keydown', onKey, true);
    window.addEventListener('resize', schedulePlace);
    window.addEventListener('scroll', schedulePlace, true);
    go(0);
  }

  /* finished: true se chegou ao fim; false se o usuário pulou */
  function stop(finished) {
    if (!running) return;
    running = false;
    root.hidden = true;
    document.removeEventListener('keydown', onKey, true);
    window.removeEventListener('resize', schedulePlace);
    window.removeEventListener('scroll', schedulePlace, true);
    cancelAnimationFrame(raf);
    if (prevFocus && prevFocus.focus) prevFocus.focus();
    if (onClose) onClose(finished);
  }

  return { start, stop: () => stop(false), isRunning: () => running };
}
