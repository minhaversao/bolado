# Agendador pessoal do Instagram

Objetivo: uso pessoal, uma conta principal, foco em agendar muitos Reels com legenda e hashtags sem depender do navegador aberto.

## Fluxo

1. Conectar conta profissional do Instagram por **Instagram Login**.
2. Selecionar até 50 vídeos.
3. Definir primeiro horário e intervalo.
4. Aplicar legenda/hashtags padrão e editar cada vídeo se quiser.
5. Enviar o lote uma única vez.
6. O servidor guarda a fila e publica no horário.
7. Falhas temporárias usam retry automático; falhas ambíguas são bloqueadas para evitar publicação duplicada.

## Importante sobre Facebook

A conexão usada é a **Instagram API with Instagram Login** com os escopos:

- `instagram_business_basic`
- `instagram_business_content_publish`

Esse modelo não exige uma Página do Facebook vinculada à conta profissional do Instagram. A publicação continua usando endpoints da Graph API da Meta, pois a API do Instagram pertence à Meta.

## Requisitos da conta

A conta do Instagram precisa ser profissional: Business ou Creator.

## Configuração local

```bash
cd instagram-personal
npm install
cp .env.example .env
npm start
```

Abra `http://localhost:3000`.

## Variáveis

Preencha `.env` fora do GitHub:

- `INSTAGRAM_APP_ID`
- `INSTAGRAM_APP_SECRET`
- `INSTAGRAM_REDIRECT_URI`
- `GITHUB_TOKEN`
- `TOKEN_ENCRYPTION_KEY`
- `SESSION_SECRET`

Nunca commite os valores reais.

## App Meta

No Meta for Developers, configure a Instagram API usando Instagram Login e cadastre exatamente a URL de callback usada em `INSTAGRAM_REDIRECT_URI`.

Para publicação, o app pede apenas os escopos necessários para perfil básico e publicação de conteúdo.

## Fila

Estados principais:

- `scheduled`: aguardando horário
- `processing`: sendo enviado/processado
- `retrying`: falha temporária; nova tentativa automática
- `published`: confirmado pelo Instagram
- `failed`: falha que exige correção
- `blocked`: publicação ficou incerta; conferir o Instagram antes de tentar novamente

O estado `blocked` existe para evitar o pior caso: uma falha de rede logo após `media_publish` gerar um retry automático e publicar o mesmo Reel duas vezes.

## Vídeos repetidos

Cada arquivo recebe SHA-256. Se o mesmo vídeo já estiver agendado, em processamento ou publicado, o novo envio é ignorado por padrão.

## Armazenamento temporário

Nesta primeira versão pessoal, o vídeo é enviado automaticamente para uma GitHub Release pública temporária. A Meta baixa o arquivo por HTTPS e, após publicação confirmada, o asset é removido.

Isso simplifica a primeira versão e reaproveita a ponte que já existia no projeto. Para uma versão de produção maior, migrar para Cloudflare R2/S3.

## Deploy

O `Dockerfile` permite colocar o app em um servidor Node/Docker 24x7. O servidor precisa manter a pasta `data/` persistente para conservar a fila e a conta conectada.

Depois do upload do lote, o computador e o navegador podem ser desligados; quem executa os horários é o servidor.

## Próxima melhoria depois do teste ponta a ponta

- geração automática de uma legenda diferente por vídeo;
- preset de tom/hashtags para `@rap.talis`;
- preview/normalização de mídia;
- armazenamento em Cloudflare R2;
- calendário visual.
