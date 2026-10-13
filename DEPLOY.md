# Deploy

Merging to `main` is the deploy. Nobody builds or restarts anything by hand.

A pull request from a branch in this repository is merged automatically as soon as its tests pass, and then deploys like any other change on `main`. A red check means it stays open and nothing is rolled out.

## What happens on a push to `main`

1. GitHub Actions (`.github/workflows/build.yml`) runs `npm test`. A failing test stops here and nothing is deployed.
2. It works out the next build number from the git tags (`b1`, `b2`, …).
3. It builds the image and pushes it to the BCR registry as `bcr-f1-fiber-list:bN` and `bcr-f1-fiber-list:latest`.
4. It tags the commit `bN`.
5. The registry tells the BCR registry module that `:latest` changed. The module looks the image up in its `DEPLOY_STACK_MAP` and redeploys the matching Portainer stack, which pulls the new image and replaces the container.

Data is not touched: it lives in the `f1-fiber-data` volume, which survives the container being replaced.

## Checking a deploy

`GET /api/health` returns the build that is running:

```json
{ "ok": true, "build": "b12" }
```

That should match the newest `bN` tag on GitHub. If it does not, the container did not take the new image — look at the Actions run first, then at the stack in Portainer.

## Rolling back

Every build keeps its own tag in the registry. In the Portainer stack, change `:latest` to the build you want (for example `:b11`) and update the stack. Put it back to `:latest` once `main` is fixed, otherwise the next push will not roll out.

## One-time setup

Already done for this repo; listed so it can be repeated elsewhere.

**GitHub** — repository secrets:

| Secret | Value |
| --- | --- |
| `REGISTRY_URL` | Registry hostname only, no `https://` — it is also used as the image prefix |
| `REGISTRY_USERNAME` | Registry user |
| `REGISTRY_PASSWORD` | Registry password |

**Portainer** — a stack using `docker-compose.production.yml`, with `REGISTRY_URL` set in the stack environment and the registry selected under *Registries* so the host can pull.

**Registry stack** — one entry added to `DEPLOY_STACK_MAP`, mapping the image name (no hostname, no tag) to the exact Portainer stack name:

```json
"bcr-f1-fiber-list": "f1-patch-list"
```

Renaming the stack or the image means updating that entry, or pushes will build but no longer roll out.
