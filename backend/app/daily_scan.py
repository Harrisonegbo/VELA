"""Daily Render Cron entrypoint. Runs one pass over configured competitor URLs."""
import asyncio
import logging
from app.main import SessionLocal, Competitor, scan_competitor

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")

async def run():
    db = SessionLocal()
    try:
        ids = [row.id for row in db.query(Competitor.id).order_by(Competitor.id.asc()).all()]
        logging.info("Starting daily scan for %s competitor(s)", len(ids))
        failures = 0
        for competitor_id in ids:
            try:
                result = await scan_competitor(competitor_id, db)
                logging.info("Competitor %s result=%s", competitor_id, result.get("status", "unknown"))
            except Exception:
                failures += 1
                logging.exception("Competitor %s scan failed", competitor_id)
                db.rollback()
        logging.info("Daily scan finished: %s scanned, %s failed", len(ids), failures)
        if failures:
            raise SystemExit(1)
    finally:
        db.close()

if __name__ == "__main__":
    asyncio.run(run())
