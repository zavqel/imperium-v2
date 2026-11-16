# IMPÉRIUM V2

Nova plataforma do IMPÉRIUM Lava Jato e Estacionamento. A V1 permanece independente.

## Componentes

- `apps/web`: site estático para GitHub Pages;
- `apps/web/admin`: painel administrativo estático, servido em `/admin/`;
- `apps/api`: Cloudflare Worker, D1, R2 e Durable Object;
- `db/migrations`: estrutura de dados versionada;
- `docs`: decisões técnicas e operação.

## Recursos já provisionados

- D1: `imperium-v2-db`;
- R2: `imperium-v2-media`;
- Worker: `imperium-v2-api`.

Não há catálogo, marcas, modelos, preços ou dados comerciais inseridos por padrão. Eles serão cadastrados após validação do negócio.

## Painel administrativo

O painel fica em `https://zavqel.github.io/imperium-v2/admin/` depois da publicação dos arquivos em `apps/web`.

Antes do primeiro acesso, defina estes **segredos do Worker** (eles não devem entrar no Git):

- `ADMIN_SESSION_SECRET`: frase aleatória com pelo menos 32 caracteres, usada para assinar sessões;
- `ADMIN_BOOTSTRAP_TOKEN`: código aleatório com pelo menos 32 caracteres, usado uma única vez para criar o proprietário inicial.

O primeiro cadastro cria o único usuário com papel `owner`. As senhas são derivadas com PBKDF2-SHA-256 e os demais cadastros são registrados em auditoria. O token de bootstrap só é enviado pela tela inicial e nunca é salvo pelo painel; remova-o ou troque-o depois do primeiro acesso.

## Operação local e infraestrutura

1. Instalar Node.js com npm e executar `npm install`.
2. Aplicar a migration com `npm run db:migrate:remote`.
3. Aplicar também a migration `0002_single_owner.sql`.
4. Definir `ALLOWED_ORIGINS` com a URL final do GitHub Pages.
5. Definir os dois segredos do painel listados acima.
6. Publicar o Worker com `npm run deploy:api`.
7. Configurar os segredos de Mercado Pago somente na etapa de pagamentos.

Nunca inclua tokens, senhas, credenciais Mercado Pago ou `.dev.vars` no Git.
