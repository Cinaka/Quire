import argparse
import asyncio

from app.db.session import AsyncSessionLocal, engine
from app.services.tombstone_cleanup import purge_expired_tombstones


def arguments() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="清理超过保留期的日记墓碑")
    parser.add_argument("--days", type=int, default=180, help="墓碑保留天数，默认 180")
    parser.add_argument("--batch-size", type=int, default=500, help="每批最多清理数量")
    return parser.parse_args()


async def run(days: int, batch_size: int) -> None:
    total_entries = 0
    total_media = 0
    try:
        async with AsyncSessionLocal() as db:
            while True:
                result = await purge_expired_tombstones(
                    db,
                    retention_days=days,
                    batch_size=batch_size,
                )
                total_entries += result.entries
                total_media += result.media
                if result.entries < batch_size:
                    break
    finally:
        await engine.dispose()

    print(f"purged entries={total_entries} media={total_media}")


def main() -> None:
    args = arguments()
    asyncio.run(run(args.days, args.batch_size))


if __name__ == "__main__":
    main()
