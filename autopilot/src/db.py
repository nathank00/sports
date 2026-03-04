"""Supabase client and database helpers for the autopilot pipeline.

Follows the same patterns as nba-pipeline/src/gamelogs.py:
- fetch_paginated() for reading large tables
- upsert_batch() for batch writes
- Module-level Supabase client initialization
"""

import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(REPO_ROOT))

import os
import logging
from supabase import create_client, Client
from dotenv import load_dotenv
from tqdm import tqdm

load_dotenv()

logging.getLogger("httpx").setLevel(logging.WARNING)
logging.getLogger("httpcore").setLevel(logging.WARNING)
logging.getLogger("supabase").setLevel(logging.WARNING)
logger = logging.getLogger(__name__)

SUPABASE_URL = os.getenv("SUPABASE_URL")
SUPABASE_KEY = os.getenv("SUPABASE_KEY")
if not SUPABASE_URL or not SUPABASE_KEY:
    raise ValueError("Missing SUPABASE_URL or SUPABASE_KEY env vars")

supabase: Client = create_client(SUPABASE_URL, SUPABASE_KEY)

PAGE_SIZE = 1000
UPSERT_BATCH_SIZE = 400


def fetch_paginated(
    table: str,
    select: str,
    filters: list | None = None,
    order_col: str | None = None,
) -> list[dict]:
    """Fetch all rows from a Supabase table using offset pagination.

    Args:
        table: table name
        select: column selection string (e.g. "*" or "id,game_id")
        filters: list of (method, column, value) tuples
                 e.g. [("eq", "season", 2024), ("gte", "game_date", "2024-01-01")]
        order_col: column to order by for stable pagination

    Returns:
        List of row dicts.
    """
    all_rows: list[dict] = []
    offset = 0

    while True:
        query = supabase.table(table).select(select)
        for method, col, val in (filters or []):
            query = getattr(query, method)(col, val)
        if order_col:
            query = query.order(order_col)
        query = query.range(offset, offset + PAGE_SIZE - 1)

        batch = query.execute().data or []
        all_rows.extend(batch)

        if len(batch) < PAGE_SIZE:
            break
        offset += PAGE_SIZE

    return all_rows


def upsert_batch(
    table: str,
    records: list[dict],
    conflict_col: str = "id",
    show_progress: bool = True,
) -> int:
    """Batch upsert records to a Supabase table.

    Args:
        table: table name
        records: list of row dicts to upsert
        conflict_col: column for ON CONFLICT (primary key)
        show_progress: show tqdm progress bar

    Returns:
        Number of successfully upserted records.
    """
    if not records:
        return 0

    success_count = 0
    batches = [
        records[i : i + UPSERT_BATCH_SIZE]
        for i in range(0, len(records), UPSERT_BATCH_SIZE)
    ]

    iterator = tqdm(batches, desc=f"Upserting to {table}") if show_progress else batches

    for batch in iterator:
        try:
            supabase.table(table).upsert(
                batch, on_conflict=conflict_col
            ).execute()
            success_count += len(batch)
        except Exception as e:
            logger.error(f"Upsert batch failed: {e}")

    return success_count


def insert_rows(table: str, records: list[dict], show_progress: bool = True) -> int:
    """Insert rows (no upsert/conflict handling). For append-only tables like signals."""
    if not records:
        return 0

    success_count = 0
    batches = [
        records[i : i + UPSERT_BATCH_SIZE]
        for i in range(0, len(records), UPSERT_BATCH_SIZE)
    ]

    iterator = tqdm(batches, desc=f"Inserting to {table}") if show_progress else batches

    for batch in iterator:
        try:
            supabase.table(table).insert(batch).execute()
            success_count += len(batch)
        except Exception as e:
            logger.error(f"Insert batch failed: {e}")

    return success_count
