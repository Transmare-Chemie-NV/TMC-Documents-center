# Azure hosting, Azure Blob Storage & SharePoint setup (Phase 4a)

Last updated: 26/11/2026

This guide covers running the TMC Document Center strictly on **Azure** (no Vercel, no Railway, no Neon):
- **Azure Container Apps** (`tmc-doccenter-web` + `tmc-doccenter-worker`)
- **Azure Database for PostgreSQL Flexible Server** (`tmc-doccenter-db`)
- **Azure Blob Storage** (`tmcdoccenterstorage`, container `documents`, passwordless Entra Managed Identity) ready for immediate testing
- **SharePoint document library** (`TMCDOCUMENTCENTER / Shared Documents` for test, live DMS in January) via Microsoft Graph `Sites.Selected`
- **Anthropic AI** on `tmc-doccenter-worker` only

---

## 1. Live standalone Azure resources (`RG_TMC-Logistics`, `westeurope`)

All Document Center resources are isolated from TMC Logistics with the `tmc-doccenter-` prefix and tag `app=tmc-document-center`:

| Resource | Name | Key settings |
|---|---|---|
| PostgreSQL Flexible Server | `tmc-doccenter-db` | `Standard_B1ms`, database `tmc_document_center`, `require_secure_transport = on` (verified TLS enforced by app), 14-day backups. |
| Container Registry | `tmcdoccenteracr.azurecr.io` | Admin user disabled; pulls via `tmc-doccenter-id` (`AcrPull`). |
| Container Apps Environment | `tmc-doccenter-env` | Linked to `tmc-doccenter-logs` (Log Analytics). |
| Web container app | `tmc-doccenter-web` | Built from `web/Dockerfile`. External HTTPS ingress on port `3000`, `minReplicas: 0`, `maxReplicas: 3`, at least **1 GiB RAM** (for up to 100 MB supplier uploads). Runs `node /app/migrate/migrate.mjs` before starting Next.js. |
| Worker container app | `tmc-doccenter-worker` | Built from `web/worker/Dockerfile`. **Internal** ingress only on port `8080`, `minReplicas: 0`, `maxReplicas: 1`. Runs Python neutralizer, LibreOffice, Tesseract, and optional Anthropic AI reader. |
| Blob Storage | `tmcdoccenterstorage` | Container `documents`. Public access disabled, shared access keys disabled, TLS 1.2+ only, passwordless Entra RBAC (`Storage Blob Data Contributor`) via `tmc-doccenter-id`. |
| User-Assigned Managed Identity | `tmc-doccenter-id` | Attached to both Container Apps (`AZURE_CLIENT_ID`). Grants `AcrPull` + `Storage Blob Data Contributor`. |

Safety rules:
- Never share a database user, secret, storage account, or Entra app registration with TMC Logistics.
- Never put secrets (`DATABASE_URL`, `AUTH_SECRET`, `ADMIN_PASSWORD_HASH`, `WORKER_WAKE_SECRET`, `SHAREPOINT_CLIENT_SECRET`, `ANTHROPIC_API_KEY`) into git or chat: store them as Azure Container App secrets (or Key Vault references).
- Never set `ANTHROPIC_API_KEY` on `tmc-doccenter-web` (worker only).

---

## 2. Switching between Azure Blob Storage (now) and SharePoint (once `Sites.Selected` is ready)

File storage is controlled by `STORAGE_BACKEND` on **both** `tmc-doccenter-web` and `tmc-doccenter-worker`:

| `STORAGE_BACKEND` | Behavior |
|---|---|
| `azure-blob` | Stores internal uploads, drafts, previews, editor views and supplier originals in `tmcdoccenterstorage / documents` using passwordless Entra Managed Identity (`AZURE_CLIENT_ID`). Works immediately before SharePoint IT approval. |
| `sharepoint` | Stores internal app files in SharePoint `_app-storage/`, enables the Neutralise SharePoint order browser/importer, and auto-publishes Final PDF + Word (`_v1`, `_v2`, never overwriting; Hard Rule 4) to matching order folders (or `General/`). |
| *(unset)* | Auto-selects SharePoint if configured, otherwise Azure Blob Storage if configured. Fails closed in production if neither is set. |

Note: Even while `STORAGE_BACKEND=azure-blob`, if you later add the `SHAREPOINT_*` env vars, SharePoint order browsing and Final auto-publishing automatically become available alongside Blob Storage. Setting `STORAGE_BACKEND=sharepoint` moves internal app storage into SharePoint `_app-storage/` as well.

---

## 3. Environment variables on Azure Container Apps

Set on **both** `tmc-doccenter-web` and `tmc-doccenter-worker`:
- `DATABASE_URL` (secret: PostgreSQL connection string for `tmc-doccenter-db` / `tmc_document_center` with `?sslmode=require`)
- `STORAGE_BACKEND=azure-blob` (switch to `sharepoint` when ready)
- `AZURE_STORAGE_ACCOUNT=tmcdoccenterstorage`
- `AZURE_STORAGE_CONTAINER=documents`
- `AZURE_CLIENT_ID` (client ID of `tmc-doccenter-id`)
- `WORKER_WAKE_SECRET` (secret, 32+ random characters)
- When SharePoint `Sites.Selected` is ready, add:
  - `SHAREPOINT_TENANT_ID`
  - `SHAREPOINT_CLIENT_ID`
  - `SHAREPOINT_CLIENT_SECRET` (secret)
  - `SHAREPOINT_DRIVE_ID` (or `SHAREPOINT_SITE_ID`)
  - Optional folder overrides: `SHAREPOINT_STORAGE_FOLDER` (default `_app-storage`), `SHAREPOINT_ORDERS_ROOT` (default empty = root), `SHAREPOINT_OUTPUT_SUBFOLDER` (default empty), `SHAREPOINT_GENERAL_FOLDER` (default `General`)

Set on **`tmc-doccenter-web` only**:
- `AUTH_SECRET` (secret, 32+ random characters)
- `ADMIN_EMAIL`, `ADMIN_NAME`, `ADMIN_PASSWORD_HASH` (secret)
- `WORKER_WAKE_URL` (internal URL of `tmc-doccenter-worker`, e.g. `https://tmc-doccenter-worker.internal.<env-domain>/wake`)
- Optional API v1.1 for TMC Logistics: `API_CLIENTS_ENABLED=on`, `APP_URL=https://<web-fqdn>`, `DC_API_MAX_BODY_MB=100`

Set on **`tmc-doccenter-worker` only**:
- `AI_READER=on` (or leave unset to keep AI off)
- `ANTHROPIC_API_KEY` (secret, from TMC's dedicated Anthropic workspace with a monthly spend cap)
- `AI_READER_MODEL=claude-opus-5-5`, `AI_READER_EFFORT=medium`, `AI_READER_MAX_CALLS=3`, `AI_READER_DAILY_CALLS=30`, `AI_READER_TIMEOUT_S=120`

---

## 4. Automatic deploy from GitHub to Azure Container Apps (OIDC, passwordless)

`.github/workflows/deploy-azure.yml` automatically builds and pushes both images to `tmcdoccenteracr.azurecr.io`, updates **`tmc-doccenter-worker`** first and **`tmc-doccenter-web`** second, and checks `/api/v1/health` whenever `checks` passes on `main` (or when run manually on `main`).

### One-time least-privilege Azure OIDC setup (zero blast radius on TMC Logistics)

1. Create a dedicated User-Assigned Managed Identity **`tmc-doccenter-deploy-id`** in `RG_TMC-Logistics` (`westeurope`) with tag `app=tmc-document-center`.
2. Add one Federated Identity Credential on `tmc-doccenter-deploy-id`:
   - Issuer: `https://token.actions.githubusercontent.com`
   - Subject: `repo:Transmare-Chemie-NV/TMC-Documents-center:environment:azure-production`
   - Audience: `api://AzureADTokenExchange`
3. Assign least-privilege roles scoped **strictly to the 4 Document Center resources only** (never the whole resource group, never TMC Logistics, never PostgreSQL or Blob Storage):
   - `AcrPush` on `tmcdoccenteracr`
   - `Contributor` on `tmc-doccenter-worker`
   - `Contributor` on `tmc-doccenter-web`
   - `Managed Identity Operator` on `tmc-doccenter-id`
4. In GitHub (`Settings > Environments`), create environment **`azure-production`** restricted strictly to branch **`main`**, and add 3 Environment secrets (non-password IDs):
   - `AZURE_CLIENT_ID` (clientId of `tmc-doccenter-deploy-id`)
   - `AZURE_TENANT_ID`
   - `AZURE_SUBSCRIPTION_ID`

### Manual build and deploy commands (Azure CLI fallback)

Run from the repository root (always deploy **worker before web**):

```bash
TAG=$(git rev-parse --short HEAD)

# 1. Build both images directly in Azure Container Registry (no local Docker needed)
az acr build --registry tmcdoccenteracr \
  --image "tmc-doccenter-worker:$TAG" \
  --file web/worker/Dockerfile .

az acr build --registry tmcdoccenteracr \
  --image "tmc-doccenter-web:$TAG" \
  --file web/Dockerfile .

# 2. Deploy worker first, then web (web runs Drizzle migrations automatically at startup)
az containerapp update \
  --resource-group RG_TMC-Logistics \
  --name tmc-doccenter-worker \
  --image "tmcdoccenteracr.azurecr.io/tmc-doccenter-worker:$TAG"

az containerapp update \
  --resource-group RG_TMC-Logistics \
  --name tmc-doccenter-web \
  --image "tmcdoccenteracr.azurecr.io/tmc-doccenter-web:$TAG"
```

Verify both apps are healthy:
```bash
WEB_FQDN=$(az containerapp show -g RG_TMC-Logistics -n tmc-doccenter-web --query properties.configuration.ingress.fqdn -o tsv)
curl -fsS "https://$WEB_FQDN/api/v1/health"
```

---

## 5. How SharePoint is organized (when enabled)

Inside the configured SharePoint document library (`SHAREPOINT_DRIVE_ID` or `SHAREPOINT_SITE_ID`):

- **`_app-storage/`** (`SHAREPOINT_STORAGE_FOLDER`, internal): uploads, working drafts, previews, editor views, and supplier originals. Hidden and blocked from the order browser, never mixed with customer-facing TMC files (Hard Rule 3).
- **Order folders** (`SHAREPOINT_ORDERS_ROOT`, default = library root): copied test orders now (e.g. `840.S0850/` or nested `Orders/2026/840.S0850/`). Users browse/search these on the Neutralise screen and import PDFs directly.
- **Published Final files:** when a document becomes `Final`, both **PDF and Word** are published automatically as `<BRIEF 7.5 name>_v1.pdf` and `<BRIEF 7.5 name>_v1.docx` (`_v2`, `_v3`, ... for newer versions, never overwriting; Hard Rule 4).
  - Documents with a dossier / order number land in their matching order folder (plus optional `SHAREPOINT_OUTPUT_SUBFOLDER` if configured).
  - General documents without a dossier number (such as general MSDS or TDS) land in `General/` (`SHAREPOINT_GENERAL_FOLDER`).

---

## 6. Entra ID App Registration & `Sites.Selected`

### If you have Entra + SharePoint admin rights

1. In **Microsoft Entra ID > App registrations > New registration**:
   - Name: `TMC Document Center`
   - Supported account types: **Single tenant** (Transmare Chemie only)
2. Open **API permissions > Add a permission > Microsoft Graph > Application permissions**:
   - Add **`Sites.Selected`** (do NOT add `Sites.ReadWrite.All`)
   - Click **Grant admin consent**
3. Open **Certificates & secrets > New client secret**:
   - Copy the **Value** directly into Azure Container App secret `sharepoint-client-secret`.
4. Grant **Write** permission ONLY to the test SharePoint site (`TMCDOCUMENTCENTER`) using Microsoft Graph (in Azure Cloud Shell or Graph Explorer as a SharePoint admin):
   - Look up the site ID:
     `GET https://graph.microsoft.com/v1.0/sites/transmare.sharepoint.com:/teams/TMCDOCUMENTCENTER?$select=id,webUrl`
   - Look up the Documents library drive ID:
     `GET https://graph.microsoft.com/v1.0/sites/{siteId}/drive?$select=id,name`
   - Grant Write access to this site only:
     `POST https://graph.microsoft.com/v1.0/sites/{siteId}/permissions`
     ```json
     {
       "roles": ["write"],
       "grantedToIdentities": [
         {
           "application": {
             "id": "<SHAREPOINT_CLIENT_ID>",
             "displayName": "TMC Document Center"
           }
         }
       ]
     }
     ```

### Copy-paste request for Cheops (if admin consent needs IT)

```text
Subject: Entra app registration + Sites.Selected for TMC Document Center (test SharePoint site)

Hi team,

For the TMC Document Center we need one single-tenant Entra ID App Registration with least-privilege SharePoint access (Sites.Selected only, limited to one test site for now):

1. App registration name: TMC Document Center (single tenant)
2. Microsoft Graph Application permission: Sites.Selected (with admin consent)
3. Site permission: Grant "write" role to this app ONLY on:
   https://transmare.sharepoint.com/teams/TMCDOCUMENTCENTER
4. Please share back (via secure channel):
   - Tenant ID
   - Application (client) ID
   - Client secret value
   - Site ID and Documents library Drive ID for TMCDOCUMENTCENTER

In January we will ask to grant the same app Write permission on the live DMS SharePoint site as well.

Thanks,
Willem
```

---

## 7. Switching to the live SharePoint DMS in January

No code changes are needed:
1. Grant the existing `TMC Document Center` Entra app `Sites.Selected` (**write**) on the live SharePoint DMS site.
2. Update `SHAREPOINT_DRIVE_ID` (and `SHAREPOINT_SITE_ID`, plus `SHAREPOINT_ORDERS_ROOT` / `SHAREPOINT_OUTPUT_SUBFOLDER` if the live DMS uses a root or output subfolder) on both `tmc-doccenter-web` and `tmc-doccenter-worker`.
3. Restart both container apps.
