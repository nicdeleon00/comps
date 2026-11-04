#!/bin/bash
# Tests supabase/schema.sql on a throwaway database: run.sh <psql connection args>
set -euo pipefail
cd "$(dirname "$0")"
db="comps_schema_test_$$"
psql "$@" -q -c "create database $db" >/dev/null
trap 'psql "$@" -q -c "drop database if exists $db" >/dev/null' EXIT
psql "$@" -d "$db" -q -v ON_ERROR_STOP=1 -f supabase-stub.sql >/dev/null
psql "$@" -d "$db" -q -v ON_ERROR_STOP=1 -f ../schema.sql >/dev/null
psql "$@" -d "$db" -q -v ON_ERROR_STOP=1 -f ../schema.sql >/dev/null   # running it twice must be safe
psql "$@" -d "$db" -v ON_ERROR_STOP=1 -f schema.test.sql | grep -E "passed|keepalive_ok|t$" || true
