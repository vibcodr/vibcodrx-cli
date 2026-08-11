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
4. instala a função de shell que preserva o comando `codex` e ativa o runtime distribuído;
5. valida a conta e a API.

Depois da configuração, use normalmente:

```bash
codex
```

Em sessões interativas, a função delega para `vibcodrx codex`, que supervisiona um Codex App Server loopback, a TUI oficial e a presença WSS. O supervisor permite explicitamente que o App Server encaminhe ao MCP somente as quatro variáveis efêmeras de capability e contexto da sessão; os valores permanecem em memória e não entram na configuração persistida do Codex. Fechar o Codex encerra todos esses filhos; não há daemon nem processo permanente.

O MCP resolve automaticamente o projeto pelo fingerprint Git e oferece as mesmas treze tools canônicas do desktop: contexto, presença/mensagens, CRUD de Anotações conectadas e CRUD de Tasks. `list_workspaces` complementa o contrato com descoberta global do tenant. A criação de Anotação grava node e corda numa única transação.

## Comandos

```text
vibcodrx             setup idempotente completo
vibcodrx login       autentica este host
vibcodrx logout      revoga e remove a credencial local
vibcodrx status      mostra o estado atual
vibcodrx doctor      testa Codex, MCP, conta e backend
vibcodrx mcp         servidor stdio usado pelo Codex
vibcodrx codex -- …  supervisor interno usado pela função de shell
```

Para desenvolvimento local, `--api-url http://127.0.0.1:4100` ou `VIBCODRX_API_URL` troca o endpoint. HTTP é recusado fora de loopback.

## Contexto e segurança

- O CLI recebe automaticamente os workspaces e nodes do tenant autenticado; não existe vínculo manual durante o setup.
- O fingerprint do projeto usa uma URL Git sanitizada e envia apenas seu hash. O desktop registra esse vínculo automaticamente; CWD absoluto e credenciais de remote não são enviados.
- Conteúdo de Anotações só pode ser lido ou alterado quando o Terminal informado possui uma corda persistida até aquela Anotação.
- `list_available_threads` mostra somente sessões Codex vivas; mensagens cross-device são confirmadas apenas depois de injetadas no App Server destinatário.
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
