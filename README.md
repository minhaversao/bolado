# Rap Talis Publisher — GitHub Bridge

Publicador em lote para Instagram Reels usando **GitHub Releases** como hospedagem temporária dos vídeos.

## Fluxo

1. Selecione vários vídeos.
2. O app envia cada vídeo como asset temporário de uma Release pública do GitHub.
3. O GitHub devolve uma URL pública de download.
4. A Meta baixa o vídeo por essa URL.
5. O app acompanha o processamento do container.
6. Publica o Reel.
7. Apaga o asset temporário do GitHub depois do sucesso.

Nenhum link precisa ser copiado manualmente.

## Requisitos

- Windows 10/11
- PowerShell 5.1 ou superior
- Repositório público GitHub (este repositório)
- Fine-grained GitHub Personal Access Token com acesso a este repositório e **Contents: Read and write**
- Instagram Professional conectado à Meta e credenciais válidas da Instagram Graph API

## Uso

1. Baixe/clonar este repositório.
2. Dê duplo clique em `INICIAR.bat`.
3. Abra **Configurações** e salve:
   - GitHub token
   - Meta access token
   - Instagram User ID
4. Clique em **Adicionar vídeos** e selecione vários MP4.
5. Edite as legendas na tabela ou importe um CSV.
6. Clique em **Publicar fila**.

## CSV de planejamento

O botão de importação aceita CSV com colunas:

```csv
arquivo,legenda
08-008-pronto.mp4,"Isso deu o que falar... #rap #hiphop"
```

O campo `arquivo` deve corresponder ao nome do arquivo já adicionado à fila.

## Segurança

Os tokens são criptografados com DPAPI do Windows e gravados somente no perfil do usuário atual em:

`%APPDATA%\RapTalisPublisher\config.json`

O GitHub token é enviado apenas para `api.github.com` / `uploads.github.com`.
O Meta token é enviado apenas para `graph.facebook.com`.

## Observações

- O repositório deve continuar público para a Meta conseguir acessar `browser_download_url` sem autenticação.
- O app mantém o vídeo no GitHub se a publicação falhar, facilitando a tentativa novamente.
- O arquivo só é removido automaticamente depois que a Meta confirma a publicação.
