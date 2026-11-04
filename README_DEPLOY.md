# VELA — live-data deployment

The dashboard no longer presents sample business records when the backend is unavailable. A live deployment requires the FastAPI service, configured user accounts, and provider credentials. This workspace currently supports QuickBooks Online for financial reports, vendors, items, bills, and purchase orders; SAP Ariba is not connected.

## What is live

- Competitor records, scans, uploaded invoice extraction, and alerts are stored by the FastAPI backend.
- QuickBooks Online connects through OAuth 2.0. VELA reads the Profit and Loss report, vendors, items, bills, and purchase orders. It does not write to QuickBooks.
- QuickBooks access and refresh tokens are encrypted in the database with `TOKEN_ENCRYPTION_KEY`; provider secrets stay on the backend.
- User accounts have `admin`, `editor`, and `viewer` roles. Registrations after initial setup remain pending until an administrator approves them.
- Sessions use random opaque browser tokens; only token hashes are stored in the database. Logging out revokes the server-side session.
- Write requests, account events, and denied privileged requests are recorded in the `audit_events` table and visible to administrators.
- Dashboard savings figures are not estimated. They remain unavailable until verified savings are recorded.
- Negotiation drafts are saved in the current browser only. Email sending is not enabled.
- SAP Ariba Procurement is not connected yet. Its tenant-specific API specification and access details must be confirmed before implementation.

## Deploy with Render Blueprint

1. Push the contents of this folder to a GitHub repository, then create a Render Blueprint from `render.yaml` for production.
2. To create staging, create a separate Blueprint from `render.staging.yaml`. It has its own API, dashboard, cron job, and PostgreSQL database; never point the staging services at production resources. The deployed production API URL is `https://vela-api-xiby.onrender.com`; the production dashboard's expected URL is `https://vela-dashboard.onrender.com`. Staging uses the `-staging` names. Confirm Render assigned these exact hostnames before relying on them.
3. Configure each environment's secret values independently in its own Render API service:
   - `BOOTSTRAP_ADMIN_TOKEN`: a unique, temporary random token used only to create the first administrator.
   - `TOKEN_ENCRYPTION_KEY`: a unique Fernet key for that environment; never share it between staging and production.
   - `QUICKBOOKS_CLIENT_ID` and `QUICKBOOKS_CLIENT_SECRET`: use the corresponding Intuit sandbox app in staging and production app in production.
   - `OPENAI_API_KEY`: configure separately per environment.
4. After the first deployment, open the dashboard and choose **Create account**. Enter the temporary bootstrap token and create the initial administrator with a unique password of at least 12 characters. Remove `BOOTSTRAP_ADMIN_TOKEN` from that Render service immediately after setup. Subsequent sign-ups are pending until an admin approves them in **Settings → Workspace access & audit**.
5. Keep all other provider secrets separate per environment. `DATABASE_URL` is supplied by each blueprint's own database. Confirm each environment's `PUBLIC_API_URL`, `DASHBOARD_URL`, `QUICKBOOKS_REDIRECT_URI`, and `CORS_ORIGINS` match the URLs assigned to its services.
6. Use `QUICKBOOKS_ENVIRONMENT=sandbox` and sandbox credentials in staging. Production should use the production Intuit app credentials and callback URL. Register the exact callback URL in the matching Intuit app.
7. Deploy, then confirm the API service's assigned URL plus `/api/health` returns `status: ok`. If it returns a plain 404, verify the URL in the Render dashboard and that the API service deployed this repository's `backend` directory; update the frontend API URL and `PUBLIC_API_URL` to the assigned API URL if it differs from the example. Only then create an account. Sign in with an individual account and use **Settings → QuickBooks Online → Connect QuickBooks**.
8. Use **Settings → Workspace access & audit** to approve registrations, assign roles, disable accounts, and inspect recent write activity.

Generate temporary setup and encryption secrets locally; do not put generated values into this repository:

```bash
python -c "import secrets; print(secrets.token_urlsafe(48))"
python -c "from cryptography.fernet import Fernet; print(Fernet.generate_key().decode())"
```

Never put provider secrets, passwords, bootstrap tokens, encryption keys, or OAuth tokens into dashboard settings, source control, or chat. Configure them only as backend environment variables. Do not reuse `TOKEN_ENCRYPTION_KEY` across environments; changing it later makes existing stored QuickBooks credentials unreadable unless they are migrated or reconnected.

## Local run

From `backend/`:

```bash
python -m venv .venv
# activate the environment, then:
pip install -r requirements.txt
copy .env.example .env
# edit .env with private values and the exact callback/origin URLs
uvicorn app.main:app --reload --port 8001
```

Serve `frontend/index.html` through a local HTTP server on the configured dashboard origin (the example uses `http://127.0.0.1:5500`). Do not open the HTML as `file://`. Set a local `BOOTSTRAP_ADMIN_TOKEN` and `TOKEN_ENCRYPTION_KEY` in `backend/.env`, then create an initial admin using the registration screen. Use a distinct local database and credentials from either hosted environment. The QuickBooks sandbox redirect URI in the example is `http://127.0.0.1:8001/api/integrations/quickbooks/callback`.

## Data interpretation and limits

- The Profit and Loss report is for the current month to date. Report contents vary with company country, subscription, and accounting settings.
- Vendor, item, bill, and purchase-order lists are capped at 100 records per dashboard refresh. Exact item descriptions are used for bill price comparisons; packaging, tax, and unit changes can make comparisons misleading. Verify source documents.
- Competitor scanning reads the supplied public page and does not bypass anti-bot controls. Only monitor pages you are permitted to access; respect site terms and rate limits.
- Invoice OCR can be wrong. Check extracted fields against the original before relying on them.
- Daily scans run at 06:00 UTC and share PostgreSQL with the API service. They do not run continuously.
- User accounts and roles protect access to one shared company workspace; data is not isolated per user or tenant. Only invite people authorized to see all workspace data.
- Administrators have full access, editors can make workspace changes, and viewers are read-only. Protect administrator accounts and review the audit trail regularly.
- SAP Ariba, automatic supplier synchronization from Ariba, email delivery, and verified savings tracking require additional implementation/configuration.
- Render pricing, Intuit approval requirements, API availability, and service plans can change. Check current provider and hosting requirements before enabling production access.
