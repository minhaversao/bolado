# Rap Talis Scheduler — MVP web

Primeira reconstrução do publicador para seguir o modelo de produto observado no SpeedPost: **OAuth oficial do Instagram + upload único + storage público temporário + fila persistente + worker no servidor + publicação pela API oficial + histórico**.

## O que já está neste MVP

- Conectar Instagram Business/Creator por OAuth, sem pedir senha.
- Solicitar somente `instagram_business_basic` e `instagram_business_content_publish`.
- Trocar token curto por token de longa duração e armazená-lo com AES-256-GCM.
- Renovar o token quando estiver próximo do vencimento.
- Selecionar até 50 vídeos de uma vez.
- Hospedar cada vídeo automaticamente em uma Release pública temporária do GitHub.
- Criar agenda em lote usando um primeiro horário + intervalo em minutos.
- Worker executado no servidor a cada minuto.
- Criar container de Reel, esperar o processamento e executar `media_publish`.
- Remover o asset temporário depois de publicação confirmada.
- Estados de fila: `scheduled`, `processing`, `published`, `failed`.
- Botão de nova tentativa e exclusão.
- Histórico de erros da Meta na própria fila.

## Arquitetura

```text
Navegador
   │
   ├── Conectar Instagram ──> OAuth Instagram/Meta
   │                              │
   │                              └── token criptografado no servidor
   │
   └── Upload de lote
          │
          ▼
   GitHub Release temporária
          │ URL HTTPS pública
          ▼
       SQLite / fila
          │
          ▼
   Worker do servidor
          │
          ├── create media container
          ├── aguarda FINISHED
          ├── media_publish
          └── limpa asset temporário
          │
          ▼
       Instagram
```

## Rodar localmente

```bash
cd speedpost-mvp
npm install
cp .env.example .env
npm start
```

Depois abra `http://localhost:3000`.

## Variáveis importantes

- `INSTAGRAM_APP_ID` e `INSTAGRAM_APP_SECRET`: aplicativo criado no painel Meta for Developers.
- `INSTAGRAM_REDIRECT_URI`: precisa ser exatamente a callback cadastrada no aplicativo Meta.
- `GITHUB_TOKEN`: token do servidor com acesso ao repositório usado como bridge temporária.
- `TOKEN_ENCRYPTION_KEY`: chave AES de 32 bytes em hexadecimal. Nunca enviar pelo chat ou commitar.
- `SESSION_SECRET`: segredo aleatório usado para proteger o fluxo OAuth.

## Para colocar 24/7

Este código precisa rodar em um servidor Node permanente. O navegador pode ser fechado depois que os vídeos terminarem de subir. O agendamento não depende do computador do usuário.

O SQLite serve para o primeiro MVP de uma conta/projeto. Antes de transformar isso em produto multiusuário, trocar por Postgres e trocar GitHub Releases por storage próprio compatível com URLs públicas temporárias.

## Próximas fases

1. Deploy HTTPS e callback real da Meta.
2. Teste ponta a ponta com `@rap.talis`.
3. Geração de legenda por IA por vídeo, com revisão antes de agendar.
4. Editor individual de legenda e horário para cada item do lote.
5. Detecção/normalização de vídeo antes do upload (H.264/AAC/faststart).
6. Métricas, calendário, workspaces e várias contas.
7. Storage próprio e Postgres para produção.

## Segurança

Não coloque tokens Meta, GitHub, App Secret ou chaves de criptografia no repositório. Use apenas variáveis de ambiente/secrets do provedor de hospedagem.
