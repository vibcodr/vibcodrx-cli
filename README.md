# Vibcodrx MCP bridge

Bridge MCP autenticado para conectar uma sessão Codex ao backend Vibcodrx. O pacote não inicia, supervisiona ou substitui o Codex e não cria App Server, proxy TUI ou wrapper de shell.

## Instalação

```bash
npm install -g @vibcodrx/cli
vibcodrx mcp login
codex
```

O login usa Device Authorization no navegador, registra somente o MCP `vibcodrx` com `codex mcp add vibcodrx -- vibcodrx mcp` e armazena a credencial no keyring Linux quando disponível. O fallback XDG usa arquivo `0600`.

O comando sem argumentos continua sendo um setup idempotente equivalente a:

1. verificar Codex;
2. autenticar o dispositivo;
3. configurar o MCP stdio;
4. validar backend e credencial.

Depois da configuração, o usuário executa `codex` diretamente.

## Runtime

Cada processo `vibcodrx mcp` mantém somente uma conexão WSS autenticada com o backend para:

- publicar a presença efêmera do host e do Workspace resolvido pelo fingerprint Git;
- receber mensagens em uma mailbox MCP;
- receber imagens coladas pelo desktop e materializá-las num diretório temporário remoto `0700`;
- criar cada arquivo de imagem com modo `0600` e remover o diretório ao encerrar.

O backend nunca persiste bytes, paths, PTYs, sessões Codex ou filesystem. O clipboard SSH segue `desktop -> HTTPS autenticado -> broker WSS -> arquivo privado no host`.

## Comandos

```text
vibcodrx                 setup idempotente completo
vibcodrx mcp login       autentica e configura o bridge MCP
vibcodrx login           autentica o host
vibcodrx logout          revoga e remove a credencial local
vibcodrx status          mostra o estado atual
vibcodrx doctor          testa Codex, MCP, conta e API
vibcodrx mcp             servidor MCP stdio iniciado pelo Codex
```

Para desenvolvimento local, `--api-url http://127.0.0.1:4100` ou `VIBCODRX_API_URL` troca o endpoint. HTTP é recusado fora de loopback.

## Contexto e ferramentas

O bridge resolve automaticamente o Workspace pelo fingerprint portátil do projeto. O MCP oferece descoberta de Workspaces e nodes, contexto de Workspace, presença, mensagens, mailbox recebida, CRUD de Anotações autorizadas por corda e CRUD de Tasks.

`list_available_threads` deve ser chamada imediatamente antes de `send_message`. O destinatário confirma a entrega ao bridge MCP; a mensagem pode ser lida pela ferramenta `list_incoming_messages`. Nenhum `threadId` interno do Codex é exigido ou exposto.

Codebase, sessão SSH, PTY e buffers do terminal continuam fora do backend e do MCP. Imagens coladas são a única exceção de bytes, com transporte efêmero e validação de assinatura.

## Desenvolvimento

```bash
npm install
npm run typecheck
npm test
npm run build
npm run pack:check
```

O pacote publica somente `dist/`, `README.md` e `LICENSE`.
