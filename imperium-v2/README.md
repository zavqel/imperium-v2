# IMPÉRIUM V2

Nova plataforma do IMPÉRIUM Lava Jato e Estacionamento. A V1 permanece independente.

## Componentes

- `apps/web`: site estático para GitHub Pages;
- `apps/api`: Cloudflare Worker, D1, R2 e Durable Object;
- `db/migrations`: estrutura de dados versionada;
- `docs`: decisões técnicas e operação.

## Recursos já provisionados

- D1: `imperium-v2-db`;
- R2: `imperium-v2-media`;
- Worker previsto: `imperium-v2-api`.

Não há catálogo, marcas, modelos, preços ou dados comerciais inseridos por padrão. Eles serão cadastrados após validação do negócio.

## Próximos passos de infraestrutura

1. Instalar Node.js com npm e executar `npm install`.
2. Aplicar a migration com `npm run db:migrate:remote`.
3. Definir `ALLOWED_ORIGINS` com a URL final do GitHub Pages.
4. Publicar o Worker com `npm run deploy:api`.
5. Configurar os segredos de Mercado Pago somente na etapa de pagamentos.

Nunca inclua tokens, senhas, credenciais Mercado Pago ou `.dev.vars` no Git.
