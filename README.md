# Vibcodrx CLI

Conecta o Codex executado em um host remoto ao estado persistido da sua conta Vibcodrx.

## Instalação

```bash
npm install -g @vibcodrx/cli
vibcodrx
```

O comando sem argumentos conduz um único fluxo:

1. verifica se o Codex está instalado;
2. abre a autorização do host no navegador, sem receber sua senha no terminal;
3. registra o servidor MCP stdio com `codex mcp add vibcodrx -- vibcodrx mcp`;
4. valida a conta e a API.

Depois da configuração, use normalmente:

```bash
codex
```

O próprio Codex inicia e encerra `vibcodrx mcp`. A primeira versão não instala daemon nem mantém processo permanente.

O MCP lista workspaces e contexto, resolve automaticamente o projeto pelo fingerprint Git e oferece CRUD de Anotações conectadas: listar, criar, ler, atualizar e excluir. A criação grava o node e a corda numa única transação.

## Comandos

```text
vibcodrx             setup idempotente completo
vibcodrx login       autentica este host
vibcodrx logout      revoga e remove a credencial local
vibcodrx status      mostra o estado atual
vibcodrx doctor      testa Codex, MCP, conta e backend
vibcodrx mcp         servidor stdio usado pelo Codex
```

Para desenvolvimento local, `--api-url http://127.0.0.1:4100` ou `VIBCODRX_API_URL` troca o endpoint. HTTP é recusado fora de loopback.

## Contexto e segurança

- O CLI recebe automaticamente os workspaces e nodes do tenant autenticado; não existe vínculo manual durante o setup.
- O fingerprint do projeto usa uma URL Git sanitizada e envia apenas seu hash. O desktop registra esse vínculo automaticamente; CWD absoluto e credenciais de remote não são enviados.
- Conteúdo de Anotações só pode ser lido ou alterado quando o Terminal informado possui uma corda persistida até aquela Anotação.
- O codebase, SSH, PTY e buffers do terminal não passam pelo backend Vibcodrx.
- A credencial fica no keyring Linux quando disponível. Em host headless, o fallback é um arquivo XDG privado com modo `0600`.
- O handshake MCP não depende da rede; falhas de API aparecem na chamada da ferramenta, sem congelar a inicialização do Codex.

## Desenvolvimento

```bash
npm install
npm run typecheck
npm test
npm run build
npm run pack:check
```

O pacote publica somente `dist/`, `README.md` e `LICENSE`.
