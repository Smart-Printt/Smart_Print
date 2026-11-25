# Putting the SmartPrint test website online

This puts the production Docker setup on one cloud server with **https**, and
makes every merged PR deploy itself. About 1 hour the first time.

What runs on the server (all from `docker-compose.prod.yml`):

```text
Internet ──https──> caddy (certificate) ──> frontend (nginx) ──/api──> backend ──> db (Postgres)
                                                                          └──> R2 bucket (files)
```

## 1. Get a server

Any Ubuntu 22.04/24.04 server with a public IP:

- **Size:** at least **2 GB RAM** (4 GB is more comfortable — LibreOffice runs
  inside the backend for Word/PPT → PDF), 25 GB disk.
- Options: DigitalOcean / Azure / AWS Lightsail with the GitHub Student Pack
  credits, or Oracle Cloud's free tier.
- Open ports **22, 80 and 443** in the provider's firewall.

## 2. Get a name for it

Caddy needs a domain name to get the https certificate.
Free option: [duckdns.org](https://www.duckdns.org) → sign in → create e.g.
`smartprint-test` → put the server's IP in it. Your domain is then
`smartprint-test.duckdns.org`.

## 3. Prepare the server (once)

SSH in, then:

```bash
curl -fsSL https://get.docker.com | sh
sudo usermod -aG docker $USER   # then log out and back in
git clone https://github.com/Smart-Printt/Smart_Print.git ~/Smart_Print
cd ~/Smart_Print/code
cp .env.production.example .env.production
nano .env.production
```

Fill in `.env.production`:

| Setting | Value |
| --- | --- |
| `POSTGRES_PASSWORD`, `JWT_SECRET` | long random values: `openssl rand -hex 32` |
| `DOMAIN` | `smartprint-test.duckdns.org` |
| `FRONTEND_URL`, `CORS_ALLOWED_ORIGINS` | `https://smartprint-test.duckdns.org` |
| `TRUST_PROXY` | `2` (caddy + nginx) |
| `PAYMENT_PROVIDER` + `RAZORPAY_*` | Razorpay **test** keys (see `backend/README.md` → Payments) |
| `STORAGE_PROVIDER` + `S3_*` | Cloudflare R2 bucket (see `backend/README.md` → File storage) |
| `EMAIL_*` | any SMTP account (e.g. a Gmail app password) |

Then start it the first time:

```bash
bash deploy/deploy.sh
```

Open `https://<your domain>` — it should show the login page. Create the first
admin with the seed script (once):

```bash
docker compose -f docker-compose.prod.yml --env-file .env.production run --rm migrate npx prisma db seed
```

> The seeded accounts use the password `DevPassword123!` — change them (or
> remove the ones you do not need) before showing the site to anyone.

## 4. Automatic deploys when a PR is merged

`.github/workflows/deploy.yml` runs after CI passes on `main` and runs
`deploy/deploy.sh` on the server over SSH.

1. On the server, make a key just for GitHub:
   ```bash
   ssh-keygen -t ed25519 -f ~/.ssh/github_deploy -N ""
   cat ~/.ssh/github_deploy.pub >> ~/.ssh/authorized_keys
   cat ~/.ssh/github_deploy      # copy this (the PRIVATE key)
   ```
2. GitHub → repo → **Settings → Secrets and variables → Actions → New
   repository secret**:
   - `DEPLOY_HOST` — the server IP or domain
   - `DEPLOY_USER` — the SSH user (e.g. `ubuntu`)
   - `DEPLOY_SSH_KEY` — the private key from step 1
   - `DEPLOY_PATH` — only if the repo is not in `~/Smart_Print`
3. Test it: **Actions → Deploy test website → Run workflow**.

Until `DEPLOY_HOST` is set, the workflow just says "skipping".

## 5. After it is online

- **Razorpay webhook:** dashboard (Test Mode) → Webhooks → Add →
  `https://<domain>/api/payments/razorpay/webhook`, events `payment.captured`
  and `order.paid`, same secret as `RAZORPAY_WEBHOOK_SECRET`.
- **Printer agent:** on the shop PC set `SMARTPRINT_URL=https://<domain>`
  (see `printer-agent/README.md`).

## Useful commands (on the server, in `~/Smart_Print/code`)

```bash
C="docker compose -f docker-compose.prod.yml --env-file .env.production --profile https"
$C ps                    # what is running
$C logs -f backend       # backend logs
$C restart backend       # restart one service
bash deploy/deploy.sh    # deploy by hand
```

**Backups:** the database lives in the `smartprint_prod_db_data` volume. A quick
backup: `$C exec db pg_dump -U smartprint smartprint > backup.sql`.
