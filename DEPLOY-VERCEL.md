# Deploy na Vercel

## 1. Banco

Crie um banco no Turso e copie:

- `TURSO_DATABASE_URL`
- `TURSO_AUTH_TOKEN`

## 2. Variaveis na Vercel

No projeto da Vercel, adicione:

- `TURSO_DATABASE_URL`
- `TURSO_AUTH_TOKEN`

## 3. Publicar

Depois de conectar o repositorio na Vercel, o deploy usa:

- [package.json](/C:/Users/pessoal/OneDrive/Documentos/New%20project/package.json)
- [vercel.json](/C:/Users/pessoal/OneDrive/Documentos/New%20project/vercel.json)
- [api/index.js](/C:/Users/pessoal/OneDrive/Documentos/New%20project/api/index.js)

## 4. Migrar os dados locais

Se quiser levar os dados do banco local atual para o banco remoto, rode:

```powershell
$env:TURSO_DATABASE_URL="libsql://seu-banco.turso.io"
$env:TURSO_AUTH_TOKEN="seu-token"
npm run migrate:remote
```

## 5. Primeiro acesso

Se o banco remoto estiver vazio:

- abra o site publicado
- crie o usuario administrador

Se voce migrou um banco que ja tinha usuario:

- entre com o usuario que ja existia no banco local
