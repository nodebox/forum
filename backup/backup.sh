#!/usr/bin/env bash
# Backs up the forum: a SQL dump of D1 and a mirror of the R2 files, to every
# rclone path in BACKUP_TARGETS (space-separated). Runs nightly in
# .github/workflows/backup.yml; setup and restore are in web/DEPLOY.md, "Backups".
#
#   BACKUP_URL           the forum's /backup.sql, e.g. https://forum.nodebox.net/backup.sql
#   BACKUP_TOKEN         the Worker's BACKUP_TOKEN secret
#   BACKUP_TARGETS       e.g. "r2:nodebox-forum-backup sb:nodebox-forum"; empty: only fetch and check the dump
#   BACKUP_FILES_SOURCE  the forum's files, e.g. "live:nodebox-forum"
#   BACKUP_OUT           where the dump is written (default: a temporary folder)
#   BACKUP_DAY           the date the run counts as (default: today, UTC)
#
# Each target gets:
#   d1/daily/forum-<day>.sql.gz     kept 35 days
#   d1/monthly/forum-<day>.sql.gz   the one of the 1st, kept 400 days
#   files/                          the forum's files as they are now
#   files-removed/<day>/            files that left the forum that day, kept 90 days
#
# The workflow logs are public, so nothing here prints names or content.
set -euo pipefail
cd "$(dirname "$0")"
: "${BACKUP_URL:?BACKUP_URL is not set}" "${BACKUP_TOKEN:?BACKUP_TOKEN is not set}"

day=${BACKUP_DAY:-$(date -u +%F)}
out=${BACKUP_OUT:-$(mktemp -d)}
mkdir -p "$out"
dump="$out/forum-$day.sql"

days_before() { date -u -d "$day -$1 days" +%F 2>/dev/null || date -u -j -v-"$1"d -f %F "$day" +%F; }

# The Worker writes the dump (web/src/backup.ts); the header comes from a file
# descriptor so the token is not in the process list.
curl -sSf --compressed --retry 3 -H @<(printf 'Authorization: Bearer %s\n' "$BACKUP_TOKEN") -o "$dump" "$BACKUP_URL"

# The dump must load into SQLite whole, with every row its last line counts, and
# search must work.
check="$out/check.sqlite"
rm -f "$check"
sql() { sqlite3 -init /dev/null -batch -noheader -list "$check" "$@"; }  # ignore ~/.sqliterc
sql -bail < "$dump"
[ "$(sql 'pragma integrity_check')" = ok ] || { echo "integrity_check failed"; exit 1; }
[ -z "$(sql 'pragma foreign_key_check')" ] || { echo "foreign_key_check failed"; exit 1; }
counts=$(tail -n 1 "$dump" | sed -n 's/^-- rows: //p')
[ -n "$counts" ] || { echo "the dump has no row counts at its end; cut off?"; exit 1; }
for pair in $counts; do
  t=${pair%%=*}
  [ "$(sql "select count(*) from \"$t\"")" = "${pair#*=}" ] || { echo "$t: rows differ from the dump's count"; exit 1; }
done
for fts in posts_fts topics_fts; do
  [ "$(sql "select count(*) from $fts")" -gt 0 ] || { echo "$fts is empty"; exit 1; }
done
rm "$check"
gzip -9nf "$dump"
echo "Dump: $(du -h "$dump.gz" | cut -f1), $(wc -w <<< "$counts" | tr -d ' ') tables, checked."

[ -n "${BACKUP_TARGETS:-}" ] || exit 0
: "${BACKUP_FILES_SOURCE:?BACKUP_FILES_SOURCE is not set}"

# Deletes the entries of a folder whose name holds a date before the cutoff.
prune() {
  local dir=$1 cutoff=$2 name date
  { rclone lsf "$dir" 2> /dev/null || true; } | while read -r name; do
    date=$(grep -oE '[0-9]{4}-[0-9]{2}-[0-9]{2}' <<< "$name" || true)
    [ -n "$date" ] && [[ "$date" < "$cutoff" ]] || continue
    if [[ "$name" == */ ]]; then rclone purge "$dir/$name"; else rclone deletefile "$dir/$name"; fi
  done
}

# A folder that does not exist yet counts as empty.
count() { local n; n=$( { rclone size --json "$1" 2> /dev/null || true; } | jq -r '.count // 0'); echo "${n:-0}"; }

source_count=$(count "$BACKUP_FILES_SOURCE")
for target in $BACKUP_TARGETS; do
  # The bucket locks d1/, so a dump uploaded earlier the same day stays as it is.
  rclone copyto --ignore-existing "$dump.gz" "$target/d1/daily/forum-$day.sql.gz"
  [ "${day:8:2}" != 01 ] || rclone copyto --ignore-existing "$dump.gz" "$target/d1/monthly/forum-$day.sql.gz"

  # A source that suddenly looks much smaller is more likely a wrong path or
  # token than a real deletion; stop before the mirror follows it.
  mirrored=$(count "$target/files")
  if [ "$source_count" -lt $(( mirrored * 9 / 10 )) ]; then
    echo "$target: the source has $source_count files, the mirror $mirrored; not syncing"; exit 1
  fi
  rclone sync "$BACKUP_FILES_SOURCE" "$target/files" --backup-dir "$target/files-removed/$day"

  prune "$target/d1/daily" "$(days_before 35)"
  prune "$target/d1/monthly" "$(days_before 400)"
  prune "$target/files-removed" "$(days_before 90)"
  echo "$target: dump uploaded, $source_count files mirrored."
done
