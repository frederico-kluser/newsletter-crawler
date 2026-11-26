# Rotina diária — newsletter-crawler no Mac mini

**Estado (2026-11-26):** instalada. Site de produção: <https://frederico-kluser.github.io/>.
O projeto Vercel antigo foi deletado (a URL antiga responde 404); o site novo vive no GitHub Pages.

## O que acontece

Todo dia às **05:00 (America/Sao_Paulo)** o LaunchDaemon `com.nc.daily-crawl` abre uma
sessão SSH local e executa `scripts/rotina-diaria.sh run`:

1. **Coleta** — `crawl --since 2026-01-01` em todas as fontes (incremental: dedup por URL +
   cursor por fonte; só notícias novas, nunca sobrescreve o acervo).
2. **Base** — `finish` drena verify/classify/summarize pendentes.
3. **Deploy** — `deploy --no-wait`: export do snapshot com o guard anti-encolhimento, commit
   numa branch efémera, PR + squash merge (a `main` é cofre).
4. **Publicação** — dispara o workflow `.github/workflows/deploy.yml` do repo
   `frederico-kluser/frederico-kluser.github.io` e faz polling de `data/meta.json` até o
   `generatedAt` novo estar no ar. O site é um artefacto do GitHub Pages (sem commits de 200 MB).

O `RunAtLoad` cobre reboot/queda de energia; a **guarda de frescura de 12 h** evita repetir a
coleta se o job já correu. O lock é o **mesmo** do comando manual (`mkdir` + PID), então a rotina
e `npm run atualizar` nunca se sobrepõem.

## Porque SSH local (e não o script direto no launchd)

Um job de launchd — mesmo root — não lê `/Volumes/Ext2TB` (TCC de volume removível): o `node`
hanga no prompt TCC sem GUI e o `bash` escreve com `Operation not permitted`. A sessão SSH local
herda a Full Disk Access do `sshd-keygen-wrapper` (o mesmo padrão do `com.ondokai.mac-kluser-web`).
Ver `docs/rotina-diaria/dossie-pesquisa.md` (E1/E3).

## Comandos

```bash
# estado: última execução, lock, saldo OpenRouter, snapshot no ar, log
bash scripts/rotina-diaria.sh status

# só checagens (não gasta): TCC/node, gh, site, banco, chave, espaço
bash scripts/rotina-diaria.sh preflight

# rodar agora, ignorando a guarda de frescura
bash scripts/rotina-diaria.sh run --force

# testar o canal de alerta (local + e-mail, se NC_SMTP_URL estiver configurado)
bash scripts/rotina-diaria.sh send-test

# instalar / verificar / desinstalar o LaunchDaemon
bash scripts/install-rotina-diaria.sh install
bash scripts/install-rotina-diaria.sh check
bash scripts/install-rotina-diaria.sh uninstall
```

`npm run atualizar` agora delega em `scripts/rotina-diaria.sh run --force` (caminho de produção).
O fluxo Vercel antigo continua acessível com `NC_LEGACY_VERCEL=1 bash scripts/coletar-e-publicar.sh`.

## Alertas

- **Local (sempre):** notificação do macOS quando disponível + log
  `~/.newsletter-crawler/logs/rotina-diaria.log` (rotação 5 MiB) e heartbeat
  `~/.local/state/nc-daily/last-run.json`.
- **E-mail (opcional, desligado por omissão):** quando `NC_SMTP_URL` existir em
  `~/.newsletter-crawler/.env`, cada run envia um resumo (sucesso) ou um alerta com as últimas
  40 linhas do log (falha), para `NC_MAIL_TO` (default `fkluser@icloud.com`).

### Ativar o e-mail (iCloud)

1. Crie uma **senha de app** em <https://appleid.apple.com> → *Sign-In and Security* →
   *App-Specific Passwords* (etiqueta: `Mac mini rotina`).
2. Acrescente ao `~/.newsletter-crawler/.env` (não cole a senha no chat):

   ```sh
   NC_SMTP_URL=smtps://fkluser@icloud.com:SENHA_DE_APP@smtp.mail.me.com:465
   NC_MAIL_TO=fkluser@icloud.com
   NC_MAIL_FROM=fkluser@icloud.com
   ```

3. `chmod 600 ~/.newsletter-crawler/.env` e teste:

   ```bash
   bash scripts/rotina-diaria.sh send-test
   ```

Também aceita `smtp://host:587` (STARTTLS) e qualquer provedor (Gmail/Brevo/Mailgun) no
`NC_SMTP_URL`. O script `scripts/notify-email.py` lê o `.env`, nunca imprime a senha e tem
`--dry-run`.

## OpenRouter

A chave fica em `~/.newsletter-crawler/.env` (`OPENROUTER_API_KEY`); o relatório mostra o saldo
`total_credits - total_usage` e avisa abaixo de `NC_MIN_OPENROUTER_USD` (default US$ 3). Em
2026-11-26 o saldo era ~US$ 11,36. Sem créditos o crawl falha com HTTP 402 e o alerta de falha
chega pelo canal local/e-mail.

## Estrutura e ficheiros

| Peça | Onde |
| --- | --- |
| Wrapper da rotina | `scripts/rotina-diaria.sh` |
| Notificador SMTP | `scripts/notify-email.py` |
| Instalador do LaunchDaemon | `scripts/install-rotina-diaria.sh` |
| Job launchd | `/Library/LaunchDaemons/com.nc.daily-crawl.plist` |
| Chave SSH local | `~/.ssh/nc-daily_ed25519` (forced command + `restrict` + `from=127.0.0.1`) |
| Estado | `~/.local/state/nc-daily/last-run.json` |
| Lock (compartilhado com o comando manual) | `~/.local/state/newsletter-crawler/coletar-e-publicar.lock` |
| Log | `~/.newsletter-crawler/logs/rotina-diaria.log` |
| Log do launchd | `~/.newsletter-crawler/logs/launchd-nc-daily.log` |
| Deploy do site | `frederico-kluser/frederico-kluser.github.io` → `.github/workflows/deploy.yml` |

## Problemas comuns

- **`preflight FALHOU` / “projeto ilegível (TCC/FDA?)”:** a sessão usada não tem FDA. Teste por
  SSH (`ssh macmini`), não pelo Terminal.app; confirme Remote Login (ⓘ) → “Allow full disk access
  for remote users”.
- **`lock ocupado`:** há uma run manual/da rotina a correr. O PID morto é assumido
  automaticamente; se for um falso positivo após reboot, remova
  `~/.local/state/newsletter-crawler/coletar-e-publicar.lock`.
- **Site atrasado:** veja o run em
  <https://github.com/frederico-kluser/frederico-kluser.github.io/actions>; a rotina faz polling
  de 15 min. O workflow também tem `workflow_dispatch` e um agendamento diário de segurança.
- **E-mail não chega:** rode `send-test`; confira `NC_SMTP_URL` e o log. O iCloud exige a senha
  de app (não a senha da conta).
- **Saldo OpenRouter:** o `status` mostra o restante; recarregue em
  <https://openrouter.ai/settings/credits>.
- **`/admin`:** a página é estática no Pages; o backend Vercel (JEV × webhook) não existe no
  GitHub Pages. O site público e a API `/api/v1/corpus.json` funcionam.
