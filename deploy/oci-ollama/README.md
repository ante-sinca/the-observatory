# OCI Ollama/Qwen inference host

This package deploys only the optional inference dependency. Project
Observatory remains on Vercel; Ollama listens only on loopback and Caddy is the
small authenticated HTTPS boundary in front of it.

```text
Vercel Observatory -- HTTPS + bearer token --> Caddy -- loopback --> Ollama/Qwen
```

No file in this directory contains a real hostname, certificate, or token.
OCI pricing and Always Free eligibility are account-, region-, resource-, and
time-dependent. Confirm capacity and price in the OCI Console before creating
anything; do not assume an Ampere A1 allocation is permanently free.

## Host and OCI network

Use an ARM64 Oracle Linux or Ubuntu VM only if suitable capacity is available.
An initial CPU inference target is up to 2 OCPUs and 12 GB RAM; it is guidance,
not a capacity or free-tier guarantee. Give the host a DNS name used only for
the protected inference endpoint.

In the VM subnet's OCI security list or network security group, allow:

- TCP 443 from the internet to the inference hostname.
- TCP 22 only when SSH administration is needed, restricted to the operator's
  fixed IP/CIDR wherever possible.
- Never TCP 11434 from any public source.

Mirror that policy in the host firewall, for example with UFW:

```bash
sudo ufw allow from <operator-ip-or-cidr> to any port 22 proto tcp
sudo ufw allow 443/tcp
sudo ufw deny 11434/tcp
sudo ufw enable
```

Caddy automatic HTTPS normally needs ACME validation. Prefer an existing
DNS-01/TLS-ALPN certificate procedure when TCP 80 must stay closed; if using
HTTP-01, allow TCP 80 only for certificate issuance/renewal according to the
chosen Caddy/CA procedure. Do not claim Vercel IP allowlisting: its outbound
addresses are not a stable allowlist for this deployment. HTTPS plus the strong
bearer token is the required application boundary.

## Install and service setup

Install ARM64 builds of Ollama and Caddy from their official operator
instructions. Do not expose Ollama's default port. Copy the included systemd
overrides and reload services:

```bash
sudo install -D -m 0644 deploy/oci-ollama/ollama.service.d/observatory.conf /etc/systemd/system/ollama.service.d/observatory.conf
sudo install -D -m 0644 deploy/oci-ollama/caddy.service.d/observatory-inference.conf /etc/systemd/system/caddy.service.d/observatory-inference.conf
sudo systemctl daemon-reload
sudo systemctl enable --now ollama caddy
sudo systemctl status ollama caddy
```

The Ollama override binds `OLLAMA_HOST=127.0.0.1:11434`, constrains parallel
work to one request, one loaded model, and a queue of four. Model storage stays
in Ollama's normal persistent data directory; do not put it in a disposable
temporary filesystem. Inspect operator logs with:

```bash
journalctl -u ollama -u caddy -f
```

Neither service needs a bespoke supervisor.

Generate a separate, strong bearer token and store it only on the host and in
Vercel's server-side environment. Never add it to this repository, `.env`, a
screenshot, command history, or shell tracing.

```bash
openssl rand -base64 48 | tr -d '\n'
sudo install -m 0600 /dev/null /etc/observatory-inference.env
sudoedit /etc/observatory-inference.env
```

The root-owned environment file contains only:

```text
OBSERVATORY_AI_PUBLIC_HOSTNAME=inference.example.com
OBSERVATORY_AI_AUTH_TOKEN=<generated-token>
```

Install `Caddyfile` as `/etc/caddy/Caddyfile`, validate it, then reload:

```bash
sudo caddy validate --config /etc/caddy/Caddyfile
sudo systemctl reload caddy
sudo ss -ltnp | grep 11434
```

The final command must show `127.0.0.1:11434`, never `0.0.0.0:11434` or a
public VM address. The Caddyfile permits only authenticated `POST /api/chat`
and authenticated `GET /api/version`, limits chat bodies to 2 MB, uses bounded
upstream timeouts, strips the bearer token before the loopback hop, returns
generic 401/404 responses, and emits no access log containing authorization
headers.

## Model lifecycle

Select exactly one server-configured CPU-friendly Qwen model initially (for
example `qwen2.5:3b` when its quality is adequate); `qwen2.5:7b` and larger
alternatives use more CPU/RAM and should be benchmarked before production use.
The browser never chooses a model. Pull and inspect it as the Ollama service
operator:

```bash
ollama pull <approved-qwen-model>
ollama list
```

For an upgrade, choose and test a candidate model, pull it, change only
`OBSERVATORY_AI_MODEL` in Vercel, run the smoke test and grounded acceptance
conversation, then remove an old model only after rollback is no longer needed.
Do not download model names supplied by browser users.

## Vercel configuration and recovery

Set these Production variables in Vercel, keeping the token secret and never
exposing it through client configuration:

```text
OBSERVATORY_AI_ENABLED=true
OBSERVATORY_ASSISTANT_UI_ENABLED=true
OBSERVATORY_AI_PROVIDER=ollama
OBSERVATORY_AI_MODEL=<approved-qwen-model>
OBSERVATORY_AI_BASE_URL=https://inference.example.com
OBSERVATORY_AI_AUTH_MODE=bearer
OBSERVATORY_AI_AUTH_TOKEN=<same-generated-token>
OBSERVATORY_AI_TIMEOUT_MS=120000
```

Production configuration fails closed unless the endpoint is HTTPS and bearer
authentication is present. Local development remains compatible with the
unauthenticated `http://127.0.0.1:11434` default. The `/api/assistant/health`
endpoint reports only the configured provider/model, a safe status, and latency;
it never returns a URL, token, prompt, or evidence. It caches each result for
15 seconds to avoid browser health-check fan-out. `reachable`, `unauthorized`, `timeout`,
`malformed_response`, and `unavailable` are operational categories, not raw
provider error bodies.

If OCI is down, credentialed incorrectly, or slow, Assistant returns its
controlled unavailable state. Ask Project, pages, refresh/ingestion, snapshots,
MCP, and all deterministic queries continue normally. Recover by checking the
host firewall/DNS/certificate, `systemctl status`, `journalctl`, the matching
token on each side, the configured model (`ollama list`), then rerun the smoke
test. Do not place inference availability on a refresh or ingestion critical
path.

## Operator smoke and production acceptance

Run from a trusted operator shell, never with `set -x`:

```bash
export OBSERVATORY_AI_BASE_URL=https://inference.example.com
export OBSERVATORY_AI_AUTH_TOKEN='<generated-token>'
export OBSERVATORY_AI_MODEL=<approved-qwen-model>
bash deploy/oci-ollama/smoke-test.sh
```

Set `OBSERVATORY_URL=https://<vercel-observatory-host>` and
`OBSERVATORY_PROJECT=homegift` to include provider-health and HomeGift checks.
The script verifies an unauthenticated rejection, authenticated health, a model
chat, Observatory health, and a grounded assistant response without printing
the token.

After OCI and Vercel are available, use the Assistant page to ask: “How much is
the platform fee?”, “Where is that configured?”, “Which tests cover it?”, and
“What revision are these answers based on?”. Check that every answer has fresh
current evidence and that a value remains incomplete when no literal/rule is
observed. Finally ask the adversarial 2% claim; it must not override evidence
policy or invent a value.
