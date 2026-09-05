# Caderno da Casa

Controle financeiro da família em uma página. HTML, CSS e JavaScript puros no cliente; servidor opcional em Python (só biblioteca padrão) com SQLite em um arquivo. Sem build, sem dependências.

## Dois modos

| Modo | Como abrir | Onde ficam os dados |
| --- | --- | --- |
| Local | `python -m http.server 8766` na pasta, ou abrir `index.html` | `localStorage` do navegador |
| Servidor | `python server/server.py` | SQLite em `data/caderno.db`, com login e histórico |

O app detecta o servidor sozinho: se `/api/ping` responde, exige login e sincroniza; senão, usa o navegador.

## Rodar localmente com servidor

```powershell
cd "C:\Users\Claudio Fernandes\Desktop\repo-files\caderno-da-casa"; python server\server.py adduser c Claudio
python server\server.py adduser e Esposa
python server\server.py
```

Abra `http://localhost:8765`. Os ids dos usuários (`c`, `e`) viram as pessoas do app; `j` (Casa) é criada automaticamente.

## O que faz

- **Painel** por dia, semana, mês ou ano: entradas, saídas, resultado previsto, atenção, saldo disponível projetado, saídas por categoria e lançamentos do período.
- **Lançamentos**: tabela com filtros por tipo, situação, pessoa, categoria e busca. Pagar ou receber ajusta o saldo da conta. Exporta CSV do período.
- **Lembretes**: pendências agrupadas em atrasados, hoje, próximos dias, até o fim do mês e a receber.
- **Recorrências**: regras mensal, quinzenal, semanal, anual e parcelado N×. Mês atual e seguinte são gerados ao abrir; geração é idempotente. Editar uma regra sincroniza só os previstos não pagos.
- **Projeções**: saldo ao fim de cada mês por 3, 6 ou 12 meses, contra o colchão mínimo.
- **Ajustes**: colchão, meta de sobra, antecedência dos lembretes, pessoas, contas e categorias. Backup e restauração em JSON. No modo servidor, histórico de alterações por revisão (quem, quando, o quê).

## Servidor

`server/server.py` serve os arquivos estáticos e a API:

| Rota | Função |
| --- | --- |
| `GET /api/ping` | diz se há servidor, quem está logado e quais usuários existem |
| `POST /api/login` `{user, senha}` | abre sessão (cookie `HttpOnly`, `SameSite=Strict`, 30 dias) |
| `POST /api/logout` | encerra a sessão |
| `GET /api/state?rev=N` | estado atual; `same: true` se a revisão não mudou |
| `PUT /api/state` `{rev, state}` | grava nova revisão; `409` se outro aparelho salvou antes (devolve o estado atual) |
| `GET /api/history?limit=30` | revisões: quando, quem, resumo |
| `GET /api/history/{rev}` | diferença detalhada de uma revisão |

Armazenamento mínimo: o estado inteiro é um documento JSON (uma linha na tabela `state`). Cada gravação registra em `history` só a diferença por item (novo, alterado, removido). Um snapshot comprimido do estado é guardado por dia, antes da primeira alteração do dia. Gravações sem mudança real não geram revisão.

Proteções: senhas com scrypt, bloqueio de 15 min após 5 erros por IP, checagem de origem em POST/PUT, CSP, `noindex`, app escuta só em `127.0.0.1` atrás do proxy HTTPS.

Comandos:

```bash
python3 server/server.py adduser <id> <nome>   # cria usuário (pede a senha)
python3 server/server.py passwd <id>           # troca a senha e encerra sessões
python3 server/server.py users                 # lista usuários
python3 server/server.py backup <arquivo.db>   # cópia consistente do banco
python3 server/server.py snapshots             # lista snapshots diários
python3 server/server.py restore <AAAA-MM-DD>  # volta ao snapshot (gera nova revisão)
python3 server/server.py export                # estado atual em JSON
```

## Publicar na VPS (Ubuntu ou Debian, com domínio apontando para a VPS)

```bash
# 1. sistema: python3 já vem; caddy faz o HTTPS
sudo apt install -y python3 caddy            # caddy: https://caddyserver.com/docs/install

# 2. usuário de serviço e código
sudo useradd -r -m -d /opt/caderno -s /usr/sbin/nologin caderno
sudo mkdir -p /opt/caderno/app && sudo chown caderno:caderno /opt/caderno/app
# copie a pasta do projeto para /opt/caderno/app (scp -r ou git clone)
sudo chown -R caderno:caderno /opt/caderno/app

# 3. usuários do app
sudo -u caderno python3 /opt/caderno/app/server/server.py adduser c Claudio
sudo -u caderno python3 /opt/caderno/app/server/server.py adduser e Esposa

# 4. serviço
sudo cp /opt/caderno/app/server/caderno.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now caderno
sudo systemctl status caderno --no-pager

# 5a. HTTPS com Caddy (VPS sem nada nas portas 80/443): edite o domínio e inicie
sudo cp /opt/caderno/app/server/Caddyfile /etc/caddy/Caddyfile
sudo nano /etc/caddy/Caddyfile
sudo systemctl enable --now caddy

# 5b. HTTPS com nginx (VPS que já tem nginx nas portas 80/443): use server/nginx.conf
sudo cp /opt/caderno/app/server/nginx.conf /etc/nginx/sites-available/caderno
sudo nano /etc/nginx/sites-available/caderno            # troque o domínio
sudo ln -s /etc/nginx/sites-available/caderno /etc/nginx/sites-enabled/caderno
sudo nginx -t && sudo systemctl reload nginx
sudo apt install -y certbot python3-certbot-nginx
sudo certbot --nginx -d SEU.DOMINIO --redirect          # emite o certificado e força HTTPS

# 6. backup diário (7 cópias rotativas em /opt/caderno)
( sudo crontab -u caderno -l 2>/dev/null; echo '30 3 * * * python3 /opt/caderno/app/server/server.py backup /opt/caderno/backup-$(date +\%u).db' ) | sudo crontab -u caderno -
```

Firewall: só 80 e 443 abertos; o app escuta em `127.0.0.1:8765`. Atualizar o app: substitua os arquivos em `/opt/caderno/app` (a pasta `data/` fica) e `sudo systemctl restart caderno`.

## Identidade visual

Cores do [ui-obs](https://github.com/claudio0507/ui-obs) (fundo, superfícies, bordas, texto e acento), tema escuro padrão e tema claro via `data-theme="light"` no `<html>`. O botão "Tema claro / Tema escuro" no trilho alterna e persiste a escolha em `localStorage` (`caderno-da-casa:theme`). Acento `#8a5cf5` = realizado; laranja (`#e9973f` escuro, `#c26a10` claro) = atenção e hoje. Sólido = aconteceu, vazado = previsto. Tipografia (Inter), tamanhos e espaçamentos vêm do protótipo original e não seguem o kit ui-obs. Sem sombras; regras de 1px e pontilhadas. Nenhuma linha de tabela quebra: células usam `white-space: nowrap` e a tabela rola dentro do próprio contêiner. Os gráficos SVG leem as cores dos tokens CSS a cada render.

## Estrutura

```
index.html             marcação, login, drawers de lançamento e recorrência
css/app.css            tokens de cor (escuro/claro), layout, componentes, responsivo
js/app.js              estado, sincronização com o servidor, recorrências, projeção, gráficos SVG, views
js/theme-init.js       aplica o tema salvo antes do CSS
server/server.py       servidor HTTP + API + SQLite (Python 3.9+, sem dependências)
server/caderno.service unidade systemd
server/Caddyfile       proxy HTTPS (Caddy)
server/nginx.conf      proxy HTTPS (nginx + certbot)
data/                  banco SQLite (criado ao rodar; fora do git)
docs/                  protótipo anterior (v0.3) para referência
```

## Modelo de dados

Documento JSON (chave `caderno-da-casa:v1` no navegador, tabela `state` no servidor):

- `lanc`: `{id, tipo, desc, valor, data, quem, cat, conta, pago, dataPago, recId, obs}`. Situação é derivada: pago → realizado; data < hoje → atrasado; data = hoje → vence hoje; senão previsto.
- `rec`: `{id, tipo, desc, valor, quem, cat, conta, freq, dia, wd, mes, parcelas, inicio, fim, ativo}`.
- `contas`: `{id, nome, tipo, saldo, reserva}`. Cartão e reserva ficam fora do saldo disponível.
- `cats`, `pessoas`, `cfg` (`colchao`, `metaSobra`, `lembreteDias`), `gerado` (competências já geradas), `seq`.

Tabelas do servidor: `users`, `sessions`, `state` (uma linha), `history` (uma por revisão, com o diff), `snapshots` (uma por dia, gzip).
