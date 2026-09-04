# Deploy setup

Everything you need to wire the `deploy.yml` workflow to Oracle.

## 1. GitHub Actions secrets

Paste these into
`https://github.com/SiddharthFulia/sid-be/settings/secrets/actions`:

| Secret | Value |
|---|---|
| `ORACLE_HOST` | `80.225.213.103` |
| `ORACLE_USER` | `ubuntu` |
| `ORACLE_SSH_KEY` | contents of `E:\Siddharth\ssh-key-2026-04-19.key` (paste the full private key, including BEGIN/END lines) |

## 2. Verify sid-be is a git checkout on Oracle

Deploy assumes `/home/ubuntu/sid-be` is a working git clone tracking
`SiddharthFulia/sid-be`. Verify once:

```bash
ssh -i "E:\Siddharth\ssh-key-2026-04-19.key" ubuntu@80.225.213.103 \
  'cd /home/ubuntu/sid-be && git remote -v && git status --short'
```

If the remote is anything other than `SiddharthFulia/sid-be`, fix with:

```bash
cd /home/ubuntu/sid-be
git remote set-url origin https://github.com/SiddharthFulia/sid-be.git
```

## 3. First run

Push any commit to `main` — the workflow runs automatically. Watch it at:
`https://github.com/SiddharthFulia/sid-be/actions`

Or trigger manually via **workflow_dispatch**:
`https://github.com/SiddharthFulia/sid-be/actions/workflows/deploy.yml`
→ **Run workflow**.

---

## Making the repos private

**Read the warning first — GitHub Free plan disables Pages on private repos.**

### Warning

- `SiddharthFulia/portfolio` currently deploys via **GitHub Pages**
  (`.github/workflows/deploy.yml` uses `actions/deploy-pages@v4`).
- **GitHub Pages only works on public repos on the Free plan.** Private-repo
  Pages needs Pro / Team / Enterprise.
- If you flip portfolio → private on Free, the site stops publishing.

### Options

| Option | Trade-off |
|---|---|
| A. Keep portfolio public, make only sid-be private | Zero risk. Sid-be doesn't need public read. |
| B. Move portfolio's hosting to Vercel first, then privatize | Vercel serves private repos on the free plan. Uses `vercel.json` you already have. |
| C. Upgrade to GitHub Pro ($4/mo) and privatize both | Cheapest all-private path. |

### Commands (once you've decided)

```bash
# sid-be — safe on any plan
gh auth switch --user SiddharthFulia
gh repo edit SiddharthFulia/sid-be --visibility private --accept-visibility-change-consequences

# portfolio — ONLY after moving hosting to Vercel or upgrading GH plan
gh repo edit SiddharthFulia/portfolio --visibility private --accept-visibility-change-consequences
```

## 4. If a repo is private, Oracle's git pull needs auth

Once `sid-be` is private, the Oracle box's `git fetch origin` inside
`deploy.yml` will fail with `Authentication required`. Two fixes:

**Fix A — deploy key (recommended):**

```bash
# On Oracle
ssh-keygen -t ed25519 -f ~/.ssh/sid-be-deploy -N ''
cat ~/.ssh/sid-be-deploy.pub
# Paste the public key at:
#   https://github.com/SiddharthFulia/sid-be/settings/keys/new
#   Title: "Oracle deploy" · leave "Allow write access" unchecked

# Point the sid-be clone at the deploy key
cat >> ~/.ssh/config <<'EOF'
Host github-sidbe
  HostName github.com
  User git
  IdentityFile ~/.ssh/sid-be-deploy
  IdentitiesOnly yes
EOF

cd /home/ubuntu/sid-be
git remote set-url origin git@github-sidbe:SiddharthFulia/sid-be.git
git fetch origin  # should succeed silently
```

**Fix B — HTTPS + PAT (works but less clean):**

Create a fine-grained PAT scoped to sid-be, then embed it in the origin URL:
`https://<PAT>@github.com/SiddharthFulia/sid-be.git`. Not recommended — the
token ends up on-disk in the git config.
