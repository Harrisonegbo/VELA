"""Scheduled competitor website and Google Places refresh worker."""
import asyncio
import argparse
import logging
from app.main import SessionLocal, Competitor, scan_competitor

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")

async def run() -> bool:
    db = SessionLocal()
    try:
        ids = [row.id for row in db.query(Competitor.id).order_by(Competitor.id.asc()).all()]
        logging.info("Starting scheduled refresh for %s competitor(s)", len(ids))
        failures = 0
        for competitor_id in ids:
            try:
                result = await scan_competitor(competitor_id, db)
                logging.info("Competitor %s result=%s", competitor_id, result.get("status", "unknown"))
                if result.get("google_maps_warning"):
                    logging.warning("Competitor %s Google Maps refresh failed: %s", competitor_id, result["google_maps_warning"])
            except Exception:
                failures += 1
                logging.exception("Competitor %s scan failed", competitor_id)
                db.rollback()
        logging.info("Scheduled refresh finished: %s scanned, %s failed", len(ids), failures)
        return failures == 0
    finally:
        db.close()

async def run_forever(interval_seconds: int) -> None:
    while True:
        await run()
        await asyncio.sleep(interval_seconds)

if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Refresh saved competitor prices and Google Places details.")
    parser.add_argument("--watch", action="store_true", help="Repeat the refresh on the configured interval.")
    parser.add_argument("--interval-minutes", type=int, default=15, help="Minutes between watch-mode refreshes.")
    args = parser.parse_args()
    if args.interval_minutes < 1:
        parser.error("--interval-minutes must be at least 1.")
    if args.watch:
        asyncio.run(run_forever(args.interval_minutes * 60))
    elif not asyncio.run(run()):
        raise SystemExit(1)
