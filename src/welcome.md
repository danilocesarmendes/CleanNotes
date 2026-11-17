# Bem-vindo ao CleanNotes

O CleanNotes é um bloco de notas em **Markdown** para quem trabalha com TI: você anota comandos, consultas e procedimentos e **copia com um clique**. Esta aba mostra cada recurso na prática. Edite à vontade: o painel da direita (preview) mostra o resultado na hora.

---

## Comece por aqui: copiar com um clique

O bloco abaixo é um **bloco de código**. Passe o mouse sobre ele: o botão de copiar fica no colchete à esquerda (ou use `Alt+B` com o cursor dentro dele). Só o comando é copiado, sem as cercas de crase.

```bash
docker compose up -d
docker compose logs -f --tail=100
```

Linhas soltas, fora de um bloco de código, também são copiáveis **uma por uma**. Clique na linha e use o ícone na coluna da direita (ou `Alt+C`):

git status
git log --oneline -n 10
git switch -c feature/minha-ideia

---

## Títulos

Use `#` no começo da linha. Quanto mais `#`, menor o título.

## Título nível 2
### Título nível 3
#### Título nível 4

Dica: no editor, a seta ao lado do número da linha **dobra** a seção do título e esconde o conteúdo dela.

---

## Linhas separadoras

Uma linha só com três hifens (`---`) desenha uma régua horizontal no preview. Ela também **separa blocos de texto** na hora de copiar: um bloco vai de uma linha em branco (ou de um `---`) até a próxima.

---

## Texto: negrito, itálico e companhia

Texto com **negrito**, *itálico*, ~~riscado~~ e `código dentro da frase`. Links ficam clicáveis: [documentação do Markdown](https://www.markdownguide.org/basic-syntax/).

> Citações começam com `>`. Boas para avisos, como "só acessível pela VPN".

## Listas e tarefas

- Item de lista
- Outro item
  - Item aninhado (dois espaços de recuo)

1. Primeiro passo
2. Segundo passo
3. Terceiro passo

- [x] Tarefa concluída
- [ ] Tarefa pendente

## Tabelas

| Ambiente | Host do banco | Porta |
|---|---|---|
| DEV | `dev-db.interno` | 5432 |
| HML | `hml-db.interno` | 5432 |

## Blocos de código por linguagem

O preview colore **bash, sql, json, yaml e java** (e, em *Configurações > Editor*, o próprio editor também). Escreva a linguagem logo depois das três crases.

```sql
-- usuários ativos nas últimas 24 horas
SELECT id, nome, ultimo_acesso
FROM usuarios
WHERE ativo = true
  AND ultimo_acesso > now() - interval '1 day'
LIMIT 10;
```

```json
{
  "servico": "api",
  "porta": 8080,
  "ativo": true
}
```

```yaml
servico:
  nome: api
  replicas: 2
  portas: [8080, 9090]
```

```java
@Override
public String url() {
    return "https://" + HOST;
}
```

Dentro de um bloco de código, linhas que começam com `#` ou `//` são **copiadas normalmente**. Fora de código, elas ficam de fora da cópia do bloco, para você poder comentar sem sujar o comando:

// esta linha de comentário não entra na cópia do bloco
echo "esta entra"
echo "esta também"

---

## Variáveis de ambiente (como no Postman)

Em vez de repetir um host ou uma porta em cada comando, defina **variáveis** em um **ambiente** (botão *Ambiente*, na barra de cima) e escreva o nome entre chaves duplas. Ao copiar, o valor do ambiente ativo entra no lugar. Os ambientes *Desenvolvimento* e *Produção* já vêm criados.

Veja o comando abaixo no preview: o host e a porta já aparecem com o valor do ambiente ativo (passe o mouse para ver o nome da variável). Troque o ambiente (ou use `Alt+E`) e copie de novo:

```bash
curl -i https://{{host}}:{{porta}}/health
```

- Variável **sem valor** não é trocada em silêncio: fica como está, em vermelho, e a cópia avisa.
- Para senhas e tokens, marque a variável como **Segredo**: o valor vai para o cofre do sistema, nunca para o arquivo da nota.

---

## Atalhos que valem decorar

| Atalho | O que faz |
|---|---|
| `Alt+C` | copia a linha do cursor |
| `Alt+B` | copia o bloco do cursor |
| `Alt+N` | cria uma aba nova |
| `Alt+P` | alterna Editor, Lado a lado e Preview |
| `Alt+E` | escolhe o ambiente de variáveis |
| `Ctrl+K` | busca em todas as abas e projetos |
| `Ctrl+F` | busca e substitui dentro da aba |
| `Ctrl+Z` | desfaz (cada aba guarda o próprio histórico) |
| `F2` | renomeia a aba |
| `F1` | reabre o tour de primeiros passos |

## E agora?

1. Crie sua primeira aba com o **+** (ou `Alt+N`).
2. Agrupe abas em **projetos**, cada um com nome, cor e sigla.
3. Quando não precisar mais deste guia, feche a aba: ela vai para a **lixeira** e pode ser restaurada.

Suas notas são arquivos `.md` comuns na sua máquina. Boas anotações!
