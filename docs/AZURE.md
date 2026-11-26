# Azure hosting & SharePoint setup (Phase 4a)

Last updated: 26/11/2026

This guide covers running the TMC Document Center on **Azure Container Apps** + **Azure Database for PostgreSQL**, connected to a **SharePoint document library** (test site `TMCDOCUMENTCENTER` now, live SharePoint DMS in January by changing two environment variables) and **Anthropic AI** on the worker.

---

## 1. Architecture on Azure (inside the TMC Logistics resource group)

Azure does not have subgroups inside a resource group. Instead, place the Document Center resources in the existing TMC Logistics resource group with the prefix `tmc-doccenter-` and tag `app=tmc-document-center`:

| Resource | Name proposal | Notes |
|---|---|---|
| PostgreSQL database | `tmc_document_center` (own DB user) | Either on TMC Logistics' existing PostgreSQL Flexible Server (separate database + separate DB user) or a small Burstable B1ms server `tmc-doccenter-db` in EU (`westeurope`). TLS (`sslmode=require`) is enforced by the app. |
| Web container app | `tmc-doccenter-web` | Built from `web/Dockerfile`. External HTTPS ingress on port `3000`, at least **1 GiB RAM** (for up to 100 MB supplier uploads). Runs `node /app/migrate/migrate.mjs` before starting Next.js. |
| Worker container app | `tmc-doccenter-worker` | Built from `web/worker/Dockerfile`. **Internal** ingress only on port `8080`, max `1` replica (runs Python neutralizer, LibreOffice, Tesseract, and optional Anthropic AI reader). |
| SharePoint library | `TMCDOCUMENTCENTER / Shared Documents` (test) | Accessed via Microsoft Graph using one Entra ID App Registration with `Sites.Selected` (Write) granted ONLY to this site. |

Safety rules:
- Never share a database user, secret, or app registration with TMC Logistics.
- Never put secrets (`SHAREPOINT_CLIENT_SECRET`, `DATABASE_URL`, `AUTH_SECRET`, `WORKER_WAKE_SECRET`, `ANTHROPIC_API_KEY`) into git or chat: store them as Azure Container App secrets (or Key Vault references).

---

## 2. How SharePoint is organized

Inside the configured SharePoint document library (`SHAREPOINT_DRIVE_ID` or `SHAREPOINT_SITE_ID`):

- **`_app-storage/`** (`SHAREPOINT_STORAGE_FOLDER`, internal): uploads, working drafts, previews, editor views, and supplier originals. Hidden and blocked from the order browser, never mixed with customer-facing TMC files (Hard Rule 3).
- **Order folders** (`SHAREPOINT_ORDERS_ROOT`, default = library root): copied test orders now (e.g. `840.S0850/` or nested `Orders/2026/840.S0850/`). Users browse/search these on the Neutralise screen and import PDFs directly.
- **Published Final files:** when a document becomes `Final`, both **PDF and Word** are published automatically as `<BRIEF 7.5 name>_v1.pdf` and `<BRIEF 7.5 name>_v1.docx` (`_v2`, `_v3`, ... for newer versions, never overwriting; Hard Rule 4).
  - Documents with a dossier / order number land in their matching order folder (plus optional `SHAREPOINT_OUTPUT_SUBFOLDER` if configured).
  - General documents without a dossier number (such as general MSDS or TDS) land in `General/` (`SHAREPOINT_GENERAL_FOLDER`).

---

## 3. Entra ID App Registration & `Sites.Selected`

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

## 4. Environment variables on Azure Container Apps

Set on **both** `tmc-doccenter-web` and `tmc-doccenter-worker`:
- `DATABASE_URL` (PostgreSQL connection string with `?sslmode=require`)
- `SHAREPOINT_TENANT_ID`
- `SHAREPOINT_CLIENT_ID`
- `SHAREPOINT_CLIENT_SECRET` (secret)
- `SHAREPOINT_DRIVE_ID` (or `SHAREPOINT_SITE_ID`)
- Optional folder overrides: `SHAREPOINT_STORAGE_FOLDER` (default `_app-storage`), `SHAREPOINT_ORDERS_ROOT` (default empty = root), `SHAREPOINT_OUTPUT_SUBFOLDER` (default empty), `SHAREPOINT_GENERAL_FOLDER` (default `General`)
- `WORKER_WAKE_SECRET` (secret, 32+ random characters)

Set on **`tmc-doccenter-web` only**:
- `AUTH_SECRET` (secret, 32+ random characters)
- `ADMIN_EMAIL`, `ADMIN_NAME`, `ADMIN_PASSWORD_HASH` (secret)
- `WORKER_WAKE_URL` (internal URL of `tmc-doccenter-worker`, e.g. `https://tmc-doccenter-worker.internal.<env-domain>/wake`)
- Optional API v1.1 for TMC Logistics: `API_CLIENTS_ENABLED=on`, `APP_URL=https://<web-url>`, `DC_API_MAX_BODY_MB=100`

Set on **`tmc-doccenter-worker` only**:
- `AI_READER=on` (or leave unset to keep AI off)
- `ANTHROPIC_API_KEY` (secret, from TMC's dedicated Anthropic workspace with a spend limit)
- `AI_READER_MODEL=claude-opus-5-5`, `AI_READER_EFFORT=medium`, `AI_READER_MAX_CALLS=3`, `AI_READER_DAILY_CALLS=30`, `AI_READER_TIMEOUT_S=120`

---

## 5. Switching to the live SharePoint DMS in January

No code changes are needed:
1. Grant the existing `TMC Document Center` Entra app `Sites.Selected` (**write**) on the live SharePoint DMS site.
2. Update `SHAREPOINT_DRIVE_ID` (and `SHAREPOINT_SITE_ID`, plus `SHAREPOINT_ORDERS_ROOT` / `SHAREPOINT_OUTPUT_SUBFOLDER` if the live DMS uses a root or output subfolder) on both `tmc-doccenter-web` and `tmc-doccenter-worker`.
3. Restart both container apps.
