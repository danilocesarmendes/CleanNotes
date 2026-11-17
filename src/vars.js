/* Variáveis de ambiente, sem DOM: `{{chave}}` vira o valor ao copiar.
 Módulo ES: usado pelo app e pelos testes (`npm run test:front`).

 - A chave não diferencia maiúsculas e aceita letras, números, _ . - (até 64).
 - Variável sem valor (ou inexistente) NÃO é substituída: o texto fica como está e a
   chave aparece em `missing`, para o aviso ao copiar.
 - O valor entra literalmente; {{ }} dentro de um valor não é expandido de novo.
 - Chave repetida: vale a primeira.
 - `secret` no retorno avisa que algum valor usado é segredo (o valor real é copiado). */
export const VAR_SOURCE = '\\{\\{\\s*([A-Za-z0-9_.-]+)\\s*\\}\\}';
export const validKey = k => /^[A-Za-z0-9_.-]{1,64}$/.test(k);

/* variables: [{ key, value }] -> Map(chave em minúsculas -> variável) só com as utilizáveis */
export function map(variables) {
  const m = new Map();
  (variables || []).forEach(v => {
    const k = v.key.toLowerCase();
    if (validKey(v.key) && v.value !== '' && !m.has(k)) m.set(k, v);
  });
  return m;
}

export function resolve(text, variables) {
  const m = map(variables), used = new Set(), missing = new Set();
  let secret = false;
  const out = text.replace(new RegExp(VAR_SOURCE, 'g'), (all, name) => {
    const v = m.get(name.toLowerCase());
    if (v) { used.add(v.key); if (v.secret) secret = true; return v.value; }
    missing.add(name); return all;
  });
  return { text: out, used: [...used], missing: [...missing], secret };
}
