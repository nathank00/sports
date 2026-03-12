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


# ── Autopilot position management helpers ──────────────────────────────


def fetch_active_users() -> list[dict]:
    """Fetch all users with auto_execute_enabled = True from autopilot_settings."""
    try:
        result = (
            supabase.table("autopilot_settings")
            .select("*")
            .eq("auto_execute_enabled", True)
            .execute()
        )
        return result.data or []
    except Exception as e:
        logger.error(f"Failed to fetch active users: {e}")
        return []


def fetch_position(user_id: str, event_id: str) -> dict | None:
    """Fetch a user's position for a specific event."""
    try:
        result = (
            supabase.table("autopilot_positions")
            .select("*")
            .eq("user_id", user_id)
            .eq("event_id", event_id)
            .limit(1)
            .execute()
        )
        rows = result.data or []
        return rows[0] if rows else None
    except Exception as e:
        logger.error(f"Failed to fetch position for {user_id}/{event_id}: {e}")
        return None


def upsert_position(user_id: str, event_id: str, data: dict) -> None:
    """Upsert a position row (creates if absent, updates if exists).

    Always sets user_id and event_id on the record.
    Uses ON CONFLICT (user_id, event_id).
    """
    record = {**data, "user_id": user_id, "event_id": event_id}
    try:
        supabase.table("autopilot_positions").upsert(
            record, on_conflict="user_id,event_id"
        ).execute()
    except Exception as e:
        logger.error(f"Failed to upsert position for {user_id}/{event_id}: {e}")


def fetch_stale_pending_intents(max_age_seconds: int = 35) -> list[dict]:
    """Find PENDING_ENTRY and PENDING_EXIT positions older than max_age_seconds."""
    from datetime import datetime, timezone, timedelta

    cutoff = (datetime.now(timezone.utc) - timedelta(seconds=max_age_seconds)).isoformat()
    try:
        result = (
            supabase.table("autopilot_positions")
            .select("*")
            .in_("state", ["PENDING_ENTRY", "PENDING_EXIT"])
            .lt("intent_created_at", cutoff)
            .execute()
        )
        return result.data or []
    except Exception as e:
        logger.error(f"Failed to fetch stale intents: {e}")
        return []


def fetch_long_positions_for_event(event_id: str) -> list[dict]:
    """Fetch all LONG_HOME and LONG_AWAY positions for a given event.

    Used by monitor_exits() to check TP/SL/late-game conditions
    across all active users holding positions on this event.
    """
    try:
        result = (
            supabase.table("autopilot_positions")
            .select("*")
            .eq("event_id", event_id)
            .in_("state", ["LONG_HOME", "LONG_AWAY"])
            .execute()
        )
        return result.data or []
    except Exception as e:
        logger.error(f"Failed to fetch long positions for {event_id}: {e}")
        return []


def fetch_user_settings(user_id: str) -> dict | None:
    """Fetch a single user's autopilot settings."""
    try:
        result = (
            supabase.table("autopilot_settings")
            .select("*")
            .eq("user_id", user_id)
            .limit(1)
            .execute()
        )
        rows = result.data or []
        return rows[0] if rows else None
    except Exception as e:
        logger.error(f"Failed to fetch settings for {user_id}: {e}")
        return None


def write_log(
    user_id: str,
    level: str,
    message: str,
    event_id: str | None = None,
    metadata: dict | None = None,
) -> None:
    """Insert a row into autopilot_logs."""
    record: dict = {
        "user_id": user_id,
        "level": level,
        "message": message,
    }
    if event_id:
        record["event_id"] = event_id
    if metadata:
        record["metadata"] = metadata

    try:
        supabase.table("autopilot_logs").insert(record).execute()
    except Exception as e:
        logger.error(f"Failed to write log: {e}")
