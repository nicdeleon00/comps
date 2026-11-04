#!/bin/bash
# Tests supabase/schema.sql on a throwaway database: run.sh <psql connection args>
set -euo pipefail
cd "$(dirname "$0")"
db="comps_schema_test_$$"
psql "$@" -q -c "create database $db" >/dev/null
trap 'psql "$@" -q -c "drop database if exists $db" >/dev/null 2>&1 || true' EXIT
psql "$@" -d "$db" -q -v ON_ERROR_STOP=1 -f supabase-stub.sql >/dev/null
psql "$@" -d "$db" -q -v ON_ERROR_STOP=1 -f ../schema.sql >/dev/null 2>&1
psql "$@" -d "$db" -q -v ON_ERROR_STOP=1 -f ../schema.sql >/dev/null 2>&1   # running it twice must be safe
out=$(psql "$@" -d "$db" -v ON_ERROR_STOP=1 -f schema.test.sql 2>&1) || { echo "$out"; echo "SCHEMA TESTS FAILED"; exit 1; }
echo "$out" | grep -q "all schema tests passed" || { echo "$out"; exit 1; }
echo "all schema tests passed"
