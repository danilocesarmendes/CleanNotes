/* Pequenas funções de texto compartilhadas. */
export const esc = s => s.replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
export const plural = (n, a, b) => n + ' ' + (n === 1 ? a : b);
