import json
import os
import re
import secrets
from datetime import date, datetime, timedelta, timezone
from typing import Any
from urllib.parse import urlencode

import httpx
from cryptography.fernet import Fernet, InvalidToken
from fastapi import APIRouter, Depends, HTTPException, Query
from fastapi.responses import RedirectResponse
from sqlalchemy.orm import Session

from .main import OAuthState, QuickBooksCredential, allowed, db_session

router = APIRouter(prefix="/api/integrations/quickbooks", tags=["QuickBooks Online"])
OAUTH_AUTHORIZE_URL = "https://appcenter.intuit.com/connect/oauth2"
OAUTH_TOKEN_URL = "https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer"


def _environment() -> str:
    value = os.getenv("QUICKBOOKS_ENVIRONMENT", "sandbox").strip().lower()
    if value not in {"sandbox", "production"}:
        raise HTTPException(503, "QUICKBOOKS_ENVIRONMENT must be sandbox or production.")
    return value


def _client_credentials() -> tuple[str, str]:
    client_id = os.getenv("QUICKBOOKS_CLIENT_ID", "").strip()
    client_secret = os.getenv("QUICKBOOKS_CLIENT_SECRET", "").strip()
    if not client_id or not client_secret:
        raise HTTPException(503, "QuickBooks OAuth client ID and secret are not configured.")
    return client_id, client_secret


def _redirect_uri() -> str:
    configured = os.getenv("QUICKBOOKS_REDIRECT_URI", "").strip()
    if configured:
        return configured
    api_base = os.getenv("PUBLIC_API_URL", os.getenv("RENDER_EXTERNAL_URL", "")).strip().rstrip("/")
    if not api_base:
        raise HTTPException(503, "Set PUBLIC_API_URL or QUICKBOOKS_REDIRECT_URI before connecting QuickBooks.")
    return f"{api_base}/api/integrations/quickbooks/callback"


def _dashboard_url() -> str:
    dashboard = os.getenv("DASHBOARD_URL", "").strip().rstrip("/")
    if not dashboard or dashboard not in allowed:
        raise HTTPException(503, "Set DASHBOARD_URL to an origin listed in CORS_ORIGINS.")
    return dashboard


def _fernet() -> Fernet:
    key = os.getenv("TOKEN_ENCRYPTION_KEY", "").strip()
    if not key:
        raise HTTPException(503, "TOKEN_ENCRYPTION_KEY is not configured.")
    try:
        return Fernet(key.encode())
    except (ValueError, TypeError):
        raise HTTPException(503, "TOKEN_ENCRYPTION_KEY must be a valid Fernet key.")


def _encrypt(value: str) -> str:
    return _fernet().encrypt(value.encode()).decode()


def _decrypt(value: str) -> str:
    try:
        return _fernet().decrypt(value.encode()).decode()
    except (InvalidToken, ValueError, TypeError):
        raise HTTPException(503, "Stored QuickBooks credentials could not be decrypted. Check TOKEN_ENCRYPTION_KEY.")


def _stored_credential(db: Session) -> QuickBooksCredential | None:
    return db.query(QuickBooksCredential).order_by(QuickBooksCredential.id.desc()).first()

def _utc_datetime(value: datetime) -> datetime:
    return value.replace(tzinfo=timezone.utc) if value.tzinfo is None else value.astimezone(timezone.utc)


def _api_base(environment: str, realm_id: str) -> str:
    host = "quickbooks.api.intuit.com" if environment == "production" else "sandbox-quickbooks.api.intuit.com"
    return f"https://{host}/v3/company/{realm_id}"


def _normalize_records(value: Any) -> list[dict[str, Any]]:
    if isinstance(value, dict):
        return [value]
    if isinstance(value, list):
        return [record for record in value if isinstance(record, dict)]
    return []


async def _exchange_token(data: dict[str, str]) -> dict[str, Any]:
    client_id, client_secret = _client_credentials()
    try:
        async with httpx.AsyncClient(timeout=20) as client:
            response = await client.post(
                OAUTH_TOKEN_URL,
                data=data,
                auth=(client_id, client_secret),
                headers={"Accept": "application/json"},
            )
        if response.is_error:
            raise HTTPException(502, f"QuickBooks OAuth failed ({response.status_code}). Recheck the app configuration and redirect URI.")
        token_data = response.json()
    except HTTPException:
        raise
    except (httpx.HTTPError, json.JSONDecodeError, ValueError) as exc:
        raise HTTPException(502, f"QuickBooks OAuth request failed: {str(exc)[:180]}")
    if not isinstance(token_data, dict) or not token_data.get("access_token") or not token_data.get("refresh_token"):
        raise HTTPException(502, "QuickBooks returned an incomplete OAuth token response.")
    return token_data


def _expire_in_seconds(token_data: dict[str, Any]) -> int:
    try:
        return max(60, int(token_data.get("expires_in", 3600)))
    except (TypeError, ValueError):
        return 3600


@router.get("/status")
def quickbooks_status(db: Session = Depends(db_session)):
    credential = _stored_credential(db)
    return {
        "configured": bool(os.getenv("QUICKBOOKS_CLIENT_ID") and os.getenv("QUICKBOOKS_CLIENT_SECRET")),
        "connected": credential is not None,
        "environment": credential.environment if credential else _environment(),
        "company_id": credential.realm_id if credential else None,
        "updated_at": credential.updated_at.isoformat() if credential else None,
    }


@router.get("/connect")
def quickbooks_connect(db: Session = Depends(db_session)):
    client_id, _ = _client_credentials()
    redirect_uri = _redirect_uri()
    _dashboard_url()
    _fernet()
    state = secrets.token_urlsafe(32)
    db.query(OAuthState).filter(
        OAuthState.provider == "quickbooks",
        OAuthState.created_at < datetime.now(timezone.utc) - timedelta(minutes=15),
    ).delete(synchronize_session=False)
    db.add(OAuthState(provider="quickbooks", state=state))
    db.commit()
    params = {
        "client_id": client_id,
        "response_type": "code",
        "scope": "com.intuit.quickbooks.accounting",
        "redirect_uri": redirect_uri,
        "state": state,
    }
    return {"authorization_url": f"{OAUTH_AUTHORIZE_URL}?{urlencode(params)}"}


@router.get("/callback")
async def quickbooks_callback(
    code: str | None = Query(default=None),
    state: str | None = Query(default=None),
    realm_id: str | None = Query(default=None, alias="realmId"),
    error: str | None = Query(default=None),
    db: Session = Depends(db_session),
):
    dashboard = _dashboard_url()
    if not state:
        raise HTTPException(400, "QuickBooks callback is missing its OAuth state.")
    state_row = db.query(OAuthState).filter_by(provider="quickbooks", state=state).first()
    if not state_row or _utc_datetime(state_row.created_at) < datetime.now(timezone.utc) - timedelta(minutes=15):
        if state_row:
            db.delete(state_row)
            db.commit()
        raise HTTPException(400, "QuickBooks OAuth state is invalid or expired. Start the connection again.")
    db.delete(state_row)
    db.commit()
    if error:
        return RedirectResponse(f"{dashboard}/?quickbooks=denied", status_code=303)
    if not code or not realm_id or not re.fullmatch(r"[A-Za-z0-9_-]{1,100}", realm_id):
        raise HTTPException(400, "QuickBooks callback is missing a valid authorization code or company ID.")

    token_data = await _exchange_token({
        "grant_type": "authorization_code",
        "code": code,
        "redirect_uri": _redirect_uri(),
    })
    existing = _stored_credential(db)
    if existing and existing.realm_id != realm_id:
        return RedirectResponse(f"{dashboard}/?quickbooks=company_mismatch", status_code=303)
    now = datetime.now(timezone.utc)
    if existing:
        existing.access_token = _encrypt(token_data["access_token"])
        existing.refresh_token = _encrypt(token_data["refresh_token"])
        existing.expires_at = now + timedelta(seconds=_expire_in_seconds(token_data))
        existing.environment = _environment()
        existing.updated_at = now
    else:
        db.add(QuickBooksCredential(
            realm_id=realm_id,
            access_token=_encrypt(token_data["access_token"]),
            refresh_token=_encrypt(token_data["refresh_token"]),
            expires_at=now + timedelta(seconds=_expire_in_seconds(token_data)),
            environment=_environment(),
            updated_at=now,
        ))
    db.commit()
    return RedirectResponse(f"{dashboard}/?quickbooks=connected", status_code=303)


@router.delete("/connection")
def quickbooks_disconnect(db: Session = Depends(db_session)):
    credential = _stored_credential(db)
    if credential:
        db.delete(credential)
        db.commit()
    return {"connected": False}


async def _refresh_credential(db: Session, credential: QuickBooksCredential) -> None:
    token_data = await _exchange_token({
        "grant_type": "refresh_token",
        "refresh_token": _decrypt(credential.refresh_token),
    })
    now = datetime.now(timezone.utc)
    credential.access_token = _encrypt(token_data["access_token"])
    credential.refresh_token = _encrypt(token_data["refresh_token"])
    credential.expires_at = now + timedelta(seconds=_expire_in_seconds(token_data))
    credential.updated_at = now
    db.commit()


async def _qbo_get(db: Session, credential: QuickBooksCredential, path: str, params: dict[str, str] | None = None) -> dict[str, Any]:
    expiry = credential.expires_at
    if expiry.tzinfo is None:
        expiry = expiry.replace(tzinfo=timezone.utc)
    if expiry <= datetime.now(timezone.utc) + timedelta(seconds=60):
        await _refresh_credential(db, credential)
    base = _api_base(credential.environment, credential.realm_id)
    for attempt in range(2):
        token = _decrypt(credential.access_token)
        try:
            async with httpx.AsyncClient(timeout=25) as client:
                response = await client.get(
                    f"{base}/{path.lstrip('/')}",
                    params=params,
                    headers={"Authorization": f"Bearer {token}", "Accept": "application/json"},
                )
            if response.status_code == 401 and attempt == 0:
                await _refresh_credential(db, credential)
                continue
            if response.is_error:
                raise HTTPException(502, f"QuickBooks data request failed ({response.status_code}) for {path}.")
            data = response.json()
        except HTTPException:
            raise
        except (httpx.HTTPError, json.JSONDecodeError, ValueError) as exc:
            raise HTTPException(502, f"QuickBooks data request failed: {str(exc)[:180]}")
        if not isinstance(data, dict):
            raise HTTPException(502, f"QuickBooks returned an invalid response for {path}.")
        return data
    raise HTTPException(502, "QuickBooks authorization expired. Reconnect the company.")


async def _query_entity(db: Session, credential: QuickBooksCredential, entity: str, limit: int = 100) -> list[dict[str, Any]]:
    query = f"select * from {entity} ORDERBY TxnDate DESC STARTPOSITION 1 MAXRESULTS {limit}"
    if entity in {"Vendor", "Item"}:
        query = f"select * from {entity} WHERE Active = true STARTPOSITION 1 MAXRESULTS {limit}"
    data = await _qbo_get(db, credential, "query", {"query": query})
    response = data.get("QueryResponse", {})
    if not isinstance(response, dict):
        raise HTTPException(502, f"QuickBooks returned an invalid {entity} query response.")
    return _normalize_records(response.get(entity))


def _line_items(entity: dict[str, Any]) -> list[dict[str, Any]]:
    normalized = []
    for line in entity.get("Line", []):
        if not isinstance(line, dict):
            continue
        detail = line.get("ItemBasedExpenseLineDetail") or {}
        item_ref = detail.get("ItemRef") or {}
        quantity = detail.get("Qty")
        unit_price = detail.get("UnitPrice")
        try:
            if unit_price is None and quantity:
                unit_price = float(line.get("Amount", 0)) / float(quantity)
            unit_price = float(unit_price) if unit_price is not None else None
        except (TypeError, ValueError, ZeroDivisionError):
            unit_price = None
        normalized.append({
            "description": str(item_ref.get("name") or line.get("Description") or "").strip(),
            "quantity": quantity,
            "unit_price": unit_price,
            "amount": line.get("Amount"),
        })
    return [line for line in normalized if line["description"]]


def _normalize_bill(bill: dict[str, Any]) -> dict[str, Any]:
    vendor = bill.get("VendorRef") or {}
    currency = bill.get("CurrencyRef") or {}
    return {
        "id": bill.get("Id"),
        "document_number": bill.get("DocNumber"),
        "supplier": vendor.get("name") or "Unknown supplier",
        "date": bill.get("TxnDate"),
        "total": bill.get("TotalAmt"),
        "balance": bill.get("Balance"),
        "currency": currency.get("value") or "UNKNOWN",
        "line_items": _line_items(bill),
    }


def _normalize_purchase_order(order: dict[str, Any]) -> dict[str, Any]:
    vendor = order.get("VendorRef") or {}
    currency = order.get("CurrencyRef") or {}
    return {
        "id": order.get("Id"),
        "document_number": order.get("DocNumber"),
        "supplier": vendor.get("name") or "Unknown supplier",
        "date": order.get("TxnDate"),
        "total": order.get("TotalAmt"),
        "currency": currency.get("value") or "UNKNOWN",
        "status": str(order.get("POStatus") or "Status unavailable"),
        "line_items": _line_items(order),
    }


def _report_group_total(report: dict[str, Any], group_name: str) -> float | None:
    def find(rows: Any) -> float | None:
        if isinstance(rows, list):
            for row in rows:
                found = find(row)
                if found is not None:
                    return found
        elif isinstance(rows, dict):
            if str(rows.get("group", "")).casefold() == group_name.casefold():
                summary = rows.get("Summary") or {}
                columns = summary.get("ColData") or []
                if columns:
                    try:
                        return float(columns[-1].get("value", ""))
                    except (TypeError, ValueError):
                        return None
            for value in rows.values():
                found = find(value)
                if found is not None:
                    return found
        return None
    return find(report.get("Rows", {}))


def _report_period() -> tuple[str, str]:
    today = date.today()
    return today.replace(day=1).isoformat(), today.isoformat()


def _price_changes(bills: list[dict[str, Any]]) -> list[dict[str, Any]]:
    def date_key(bill: dict[str, Any]) -> str:
        return str(bill.get("date") or "")

    ordered = sorted(bills, key=date_key)
    prior_prices: dict[tuple[str, str], dict[str, Any]] = {}
    changes = []
    for bill in ordered:
        supplier = str(bill.get("supplier") or "").casefold()
        for item in bill.get("line_items", []):
            try:
                unit_price = float(item.get("unit_price"))
            except (TypeError, ValueError):
                continue
            if not supplier or unit_price < 0:
                continue
            key = (supplier, str(item.get("description") or "").casefold())
            previous = prior_prices.get(key)
            if previous and previous["unit_price"] > 0 and previous["unit_price"] != unit_price:
                changes.append({
                    "supplier": bill.get("supplier"),
                    "item": item.get("description"),
                    "date": bill.get("date"),
                    "currency": bill.get("currency"),
                    "previous_unit_price": previous["unit_price"],
                    "unit_price": unit_price,
                    "change_percent": round((unit_price - previous["unit_price"]) / previous["unit_price"] * 100, 2),
                    "evidence": f"QuickBooks bills {previous['document_number'] or previous['date']} and {bill.get('document_number') or bill.get('date')}",
                })
            prior_prices[key] = {
                "unit_price": unit_price,
                "date": bill.get("date"),
                "document_number": bill.get("document_number"),
            }
    return changes[-100:][::-1]


@router.get("/dashboard")
async def quickbooks_dashboard(db: Session = Depends(db_session)):
    credential = _stored_credential(db)
    if not credential:
        raise HTTPException(409, "Connect a QuickBooks company before loading live financial data.")
    start_date, end_date = _report_period()
    report = await _qbo_get(
        db,
        credential,
        "reports/ProfitAndLoss",
        {"start_date": start_date, "end_date": end_date},
    )
    company_response = await _qbo_get(db, credential, f"companyinfo/{credential.realm_id}")
    company_info = company_response.get("CompanyInfo") or {}
    vendors = await _query_entity(db, credential, "Vendor")
    items = await _query_entity(db, credential, "Item")
    bills = [_normalize_bill(row) for row in await _query_entity(db, credential, "Bill")]
    purchase_orders = [_normalize_purchase_order(row) for row in await _query_entity(db, credential, "PurchaseOrder")]

    income = _report_group_total(report, "Income")
    expenses = _report_group_total(report, "Expenses")
    cost_of_goods_sold = _report_group_total(report, "COGS")
    if cost_of_goods_sold is None:
        cost_of_goods_sold = _report_group_total(report, "Cost of Goods Sold")
    if expenses is not None and cost_of_goods_sold is not None:
        expenses += cost_of_goods_sold
    net_income = _report_group_total(report, "NetIncome")
    currency = str((report.get("Header") or {}).get("Currency") or "UNKNOWN")
    return {
        "provider": "QuickBooks Online",
        "company_id": credential.realm_id,
        "company_name": company_info.get("CompanyName") or company_info.get("LegalName"),
        "environment": credential.environment,
        "fetched_at": datetime.now(timezone.utc).isoformat(),
        "period": {"start": start_date, "end": end_date},
        "kpis": {
            "income": income,
            "expenses": expenses,
            "net_income": net_income,
            "currency": currency,
            "verified_savings": None,
            "savings_note": "No verified savings value is available until measured savings are recorded.",
        },
        "vendors": [{
            "id": vendor.get("Id"),
            "name": vendor.get("DisplayName") or vendor.get("CompanyName") or "Unnamed supplier",
            "active": vendor.get("Active", True),
        } for vendor in vendors],
        "items": [{
            "id": item.get("Id"),
            "name": item.get("Name") or "Unnamed item",
            "description": item.get("Description") or "",
            "type": item.get("Type") or "",
            "unit_price": item.get("UnitPrice"),
            "currency": currency,
        } for item in items],
        "bills": bills,
        "purchase_orders": purchase_orders,
        "price_changes": _price_changes(bills),
        "data_limit": 100,
    }


def include_quickbooks_router(app):
    app.include_router(router)
