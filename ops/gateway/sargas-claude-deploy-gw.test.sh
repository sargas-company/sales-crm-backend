#!/bin/bash
# Offline test suite for sargas-claude-deploy-gw (Wave 3, Card 1).
# All fixtures live in a mktemp dir; production paths, state and the
# real home directory are never touched. Run: bash sargas-claude-deploy-gw.test.sh

HERE="$(cd "$(dirname "$0")" && pwd)"
GW="$HERE/sargas-claude-deploy-gw"
BE_REPO_REAL="$(cd "$HERE/../.." && pwd)"   # sales-crm-backend (read-only corpus source)
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

pass=0; failn=0
ok()   { printf 'PASS  %s\n' "$1"; pass=$((pass+1)); }
bad()  { printf 'FAIL  %s%s\n' "$1" "${2:+ — $2}"; failn=$((failn+1)); }

# ---------- T1: syntax ----------
if bash -n "$GW"; then ok "bash -n"; else bad "bash -n"; fi

# ---------- T2: whole-string grammar (exit codes via real invocation) ----------
g() { # g <desc> <want-exit> <cmd>  (full invocation; lib flag force-cleared)
  local out rc
  out="$(SARGAS_DEPLOY_GW_LIB_ONLY= SSH_ORIGINAL_COMMAND="$3" bash "$GW" --test-root "$TMP" 2>&1)"; rc=$?
  if [[ "$rc" == "$2" ]] && ! grep -q 'uid=' <<<"$out"; then
    ok "grammar[$1] exit=$rc"
  else
    bad "grammar[$1]" "exit=$rc want=$2"
  fi
}
SHA_A='aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
SHA_B='bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'
g 'empty'                 2 ''
g 'unknown verb'          2 'frobnicate'
g 'deploy-run rejected'   2 "deploy-run $SHA_A $SHA_B"
g 'bare deploy-plan'      2 'deploy-plan'
g 'plan 1 sha only'       2 "deploy-plan $SHA_A"
g 'plan 39-hex'           2 "deploy-plan ${SHA_A:0:39} $SHA_B"
g 'plan 41-hex'           2 "deploy-plan ${SHA_A}a $SHA_B"
g 'plan uppercase hex'    2 "deploy-plan AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA $SHA_B"
g 'plan trailer'          2 "deploy-plan $SHA_A $SHA_B extra"
g 'plan injection ;id'    2 "deploy-plan $SHA_A $SHA_B;id"
g 'tab control char'      2 $'deploy-status\t10'
g 'newline payload'       2 $'deploy-status 10\nid'
g 'overlong >128'         2 "deploy-plan $SHA_A $SHA_B $SHA_A $SHA_B"
g 'status 0'              2 'deploy-status 0'
g 'status 201'            2 'deploy-status 201'
g 'status abc'            2 'deploy-status abc'
g 'status 10;id'          2 'deploy-status 10;id'
g 'bare deploy-unlock'    2 'deploy-unlock'
g 'unlock traversal'      2 'deploy-unlock ../../etc'
g 'unlock bad id shape'   2 'deploy-unlock d123-zz'
# Accepted by grammar; execution hits missing prod binaries/lock (not exit 2):
g 'ACCEPT status bare'    0 'deploy-status'
g 'ACCEPT status 10'      0 'deploy-status 10'
g 'ACCEPT plan -> unreadable (pinned binaries absent locally)' 1 "deploy-plan $SHA_A $SHA_B"
g 'ACCEPT plan equal SHAs (grammar-valid)' 1 "deploy-plan $SHA_A $SHA_A"
g 'ACCEPT unlock no lock -> failed' 1 'deploy-unlock d1234567890-abcd'

# ---------- source lib for unit tests ----------
OLD_PATH="$PATH"
export SARGAS_DEPLOY_GW_LIB_ONLY=1   # stays on for the whole unit phase (PROC_ROOT gate)
# shellcheck disable=SC1090
if source "$GW" --test-root "$TMP"; then
  ok "lib-only source"
else
  bad "lib-only source"
fi
set +e; set +u; set +o pipefail   # the sourced script enables strict mode
PATH="$OLD_PATH"                   # restore dev PATH (pinned prod PATH has no local node/git)
NODE_BIN="$(command -v node)"
GIT_BIN="$(command -v git)"
# macOS has no `timeout`; shim it for lib-mode unit tests only.
command -v timeout >/dev/null 2>&1 || timeout() { shift; "$@"; }

# ---------- T3: classifier fixtures ----------
cls() { # cls <desc> <want-rc 0|1> <sql>
  printf '%s' "$3" > "$TMP/f.sql"
  classify_sql_file "$TMP/f.sql" >/dev/null 2>&1
  local rc=$?
  if [[ "$rc" == "$2" ]]; then ok "classifier[$1]"; else bad "classifier[$1]" "rc=$rc want=$2"; fi
}
cls 'safe create table'      0 'CREATE TABLE "T" ("id" TEXT NOT NULL, CONSTRAINT "T_pkey" PRIMARY KEY ("id"));'
cls 'safe create index'      0 'CREATE UNIQUE INDEX "i" ON "T"("a", "b");'
cls 'safe add column'        0 'ALTER TABLE "T" ADD COLUMN "c" INTEGER NOT NULL DEFAULT 0;'
cls 'safe add constraint'    0 'ALTER TABLE "T" ADD CONSTRAINT "fk" FOREIGN KEY ("a") REFERENCES "U"("id") ON DELETE SET NULL;'
cls 'safe set default'       0 'ALTER TABLE "T" ALTER COLUMN "c" SET DEFAULT 5;'
cls 'safe enum add value'    0 "ALTER TYPE \"E\" ADD VALUE 'NEW';"
cls 'safe insert'            0 "INSERT INTO \"Permission\" (\"id\",\"key\") VALUES ('1','x');"
cls 'safe comment + comments stripped' 0 $'-- line comment\n/* block */ COMMENT ON TABLE "T" IS \'t\';'
cls 'safe extension'         0 'CREATE EXTENSION IF NOT EXISTS "vector";'
cls 'drop table'             1 'DROP TABLE "T";'
cls 'drop column'            1 'ALTER TABLE "T" DROP COLUMN "c";'
cls 'rename column'          1 'ALTER TABLE "T" RENAME COLUMN "a" TO "b";'
cls 'truncate'               1 'TRUNCATE "T";'
cls 'delete'                 1 'DELETE FROM "T" WHERE 1=1;'
cls 'update'                 1 "UPDATE \"T\" SET \"a\"='x';"
cls 'set not null'           1 'ALTER TABLE "T" ALTER COLUMN "c" SET NOT NULL;'
cls 'set data type'          1 'ALTER TABLE "T" ALTER COLUMN "c" SET DATA TYPE BIGINT;'
cls 'do block'               1 $'DO $$ BEGIN PERFORM 1; END $$;'
cls 'grant (unknown)'        1 'GRANT SELECT ON "T" TO u;'
cls 'gibberish (unknown)'    1 'FROBNICATE THE DATABASE;'
cls 'multi-clause alter'     1 'ALTER TABLE "T" ADD COLUMN "a" TEXT, DROP COLUMN "b";'
cls 'odd quote fail-closed'  1 "INSERT INTO \"T\" VALUES ('a;b);"
# Reviewer attack corpus (must stay manual forever):
cls 'tagged dollar-quote hides DROP' 1 'INSERT INTO t VALUES ($q$ -- $q$); DROP TABLE users;'
cls 'non-ASCII dollar tag hides DROP' 1 'INSERT INTO t VALUES ($é$ -- $é$); DROP TABLE users;'
cls 'any bare dollar fail-closed'     1 "INSERT INTO t (\"v\") VALUES ('price \$10');"
cls 'quoted-ident hides DROP COLUMN' 1 'ALTER TABLE t DROP COLUMN "c ADD CONSTRAINT x";'
cls 'quoted-ident hides RENAME'      1 'ALTER TABLE t RENAME COLUMN "a ADD COLUMN b" TO c;'
cls 'empty file fail-closed'         1 ''
cls 'comment-only file fail-closed'  1 $'-- nothing here\n'
cls 'literal DROP text stays safe'   0 "INSERT INTO \"T\" (\"v\") VALUES ('DROP TABLE users');"
cls 'multi-add-column auto'          0 'ALTER TABLE "User" ADD COLUMN "a" TEXT, ADD COLUMN "b" TEXT;'
cls 'line-comment marker in identifier hides DROP'  1 'ALTER TABLE t ADD CONSTRAINT "c--" CHECK (true), DROP COLUMN big;'
cls 'block-comment marker in identifier hides DROP' 1 $'ALTER TABLE t ADD COLUMN "a/*" INT, DROP COLUMN b; -- */'
cls 'escaped-quote identifier stays auto'           0 'ALTER TABLE "T" ADD COLUMN "a""b" INTEGER;'
cls 'rebalanced quotes across stripped region'      1 $'ALTER TABLE t ADD CONSTRAINT "c--" CHECK (true), DROP COLUMN big, ADD COLUMN "z\nw" INT;'
cls 'rebalanced block-comment variant'              1 'ALTER TABLE t ADD COLUMN "a/*" INT, DROP COLUMN b, ADD COLUMN "q */ w" INT;'
cls 'newline inside identifier, additive only'      0 $'ALTER TABLE "T" ADD COLUMN "z\nw" INTEGER;'
cls 'backslash gate (E-string escape)'              1 "INSERT INTO t VALUES (E'a\\'b; DROP TABLE x');"
cls 'nested block comment consumed'                 0 $'/* outer /* inner */ still comment */\nCREATE TABLE "T" ("id" TEXT NOT NULL);'
cls 'unterminated block comment fail-closed'        1 $'/* never closed\nCREATE TABLE "T" ("id" TEXT);'

# ---------- T4: corpus over all real migrations (read-only) ----------
CORPUS_DIR="$BE_REPO_REAL/prisma/migrations"
total=0; auto=0; manual=0; manual_list=()
while IFS= read -r f; do
  total=$((total+1))
  if classify_sql_file "$f" >/dev/null 2>&1; then
    auto=$((auto+1))
  else
    manual=$((manual+1))
    manual_list+=("${f#"$CORPUS_DIR"/}")
  fi
done < <(find "$CORPUS_DIR" -mindepth 2 -maxdepth 2 -name migration.sql | sort)
printf 'CORPUS total=%d auto=%d manual=%d\n' "$total" "$auto" "$manual"
if (( total > 0 )); then ok "corpus ran over $total migrations"; else bad "corpus" "no migrations found"; fi
if (( manual > 0 )); then
  printf 'CORPUS manual-required list:\n'
  printf '  %s\n' "${manual_list[@]}"
fi

# ---------- T5: seed watch-set + import guard (fixture git repo) ----------
R="$TMP/repo"
mkdir -p "$R/prisma" "$R/src/auth"
git -C "$TMP" init -q repo
git -C "$R" config user.email t@t; git -C "$R" config user.name t
cat > "$R/prisma/seed-system.ts" <<'EOF'
import 'dotenv/config';
import { PrismaClient } from '@prisma/client';
import { OWNER } from '../src/auth/system-role-presets';
EOF
printf 'export const OWNER = 1;\n' > "$R/src/auth/system-role-presets.ts"
printf '{}\n' > "$R/prisma/tsconfig-seed.json"
printf '{"name":"x"}\n' > "$R/package.json"
printf 'readme\n' > "$R/README.md"
git -C "$R" add -A; git -C "$R" commit -qm base
BASE="$(git -C "$R" rev-parse HEAD)"

printf 'export const OWNER = 2;\n' > "$R/src/auth/system-role-presets.ts"
git -C "$R" add -A; git -C "$R" commit -qm presets
PRESETS="$(git -C "$R" rev-parse HEAD)"

printf 'readme2\n' > "$R/README.md"
git -C "$R" add -A; git -C "$R" commit -qm readme
README="$(git -C "$R" rev-parse HEAD)"

cat >> "$R/prisma/seed-system.ts" <<'EOF'
import { evil } from '../src/evil-helper';
EOF
git -C "$R" add -A; git -C "$R" commit -qm evil
EVIL="$(git -C "$R" rev-parse HEAD)"

git -C "$R" checkout -q "$BASE"
if seed_delta "$R" "$PRESETS" >/dev/null; then ok "seed_delta presets change -> true"; else bad "seed_delta presets"; fi
git -C "$R" checkout -q "$PRESETS"
if ! seed_delta "$R" "$README" >/dev/null; then ok "seed_delta readme-only -> false"; else bad "seed_delta readme-only"; fi
out="$(git -C "$R" checkout -q "$README"; seed_delta "$R" "$EVIL")"
if [[ $? -eq 0 && "$out" == *import-guard*evil-helper* ]]; then ok "seed_delta import-guard fires"; else bad "seed_delta import-guard" "$out"; fi

# migration_delta on the fixture (none expected)
if [[ -z "$(migration_delta "$R" "$EVIL")" ]]; then ok "migration_delta none on fixture"; else bad "migration_delta fixture"; fi

# ---------- T6: state schema ----------
mkdir -p "$STATE_DIR"
cat > "$STATE_FILE" <<'EOF'
{"schema":1,"deployed_backend_sha":"x","previous_backend_sha":"y",
 "published_frontend_sha":"z","previous_frontend_sha":"w","fe_release_dir":"/tmp/r"}
EOF
if state_valid && [[ "$(state_get deployed_backend_sha)" == x ]]; then ok "state valid+get"; else bad "state valid+get"; fi
printf '{"schema":1}\n' > "$STATE_FILE"
if ! state_valid; then ok "state missing keys -> invalid"; else bad "state missing keys"; fi
printf 'not json\n' > "$STATE_FILE"
if ! state_valid; then ok "state broken json -> invalid"; else bad "state broken json"; fi
rm -f "$STATE_FILE"
if ! state_valid; then ok "state absent -> invalid"; else bad "state absent"; fi

# ---------- T7: PID start-identity ----------
PROC_ROOT="$TMP/proc"; export PROC_ROOT
mkdir -p "$PROC_ROOT/4242"
printf '4242 (co mm (weird)) S 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 777 1 2 3\n' > "$PROC_ROOT/4242/stat"
if [[ "$(proc_starttime 4242)" == 777 ]]; then ok "proc_starttime parses past comm"; else bad "proc_starttime" "$(proc_starttime 4242)"; fi
if runner_alive 4242 777; then ok "runner_alive matching"; else bad "runner_alive matching"; fi
if ! runner_alive 4242 778; then ok "runner_alive reuse-mismatch -> dead"; else bad "runner_alive reuse"; fi
if ! runner_alive 9999 777; then ok "runner_alive no-proc -> dead"; else bad "runner_alive no-proc"; fi

# ---------- T8: lock + unlock safety ----------
rm -rf "$LOCK_DIR"; mkdir -p "$STATE_DIR"
printf 'keep\n' > "$STATE_DIR/keepme"
if lock_acquire d1760000000-abcd "$SHA_A" "$SHA_B" p1 p2 4242 777; then ok "lock_acquire"; else bad "lock_acquire"; fi
if ! lock_acquire d1760000000-ffff "$SHA_A" "$SHA_B" p1 p2 1 1 2>/dev/null; then ok "second acquire refused"; else bad "second acquire"; fi
if [[ "$(lock_get DEPLOY_ID)" == d1760000000-abcd ]]; then ok "lock_get"; else bad "lock_get"; fi
out="$(v_deploy_unlock d1760000000-zzzz 2>&1)" && bad "unlock wrong id accepted" || true
# wrong-id shape is caught by grammar in real calls; here direct fn call:
out="$(v_deploy_unlock d1760000001-ffff 2>&1)"; rc=$?
if [[ $rc -ne 0 && "$out" == *mismatch* && -d "$LOCK_DIR" ]]; then ok "unlock id-mismatch refused"; else bad "unlock id-mismatch" "$out"; fi
out="$(v_deploy_unlock d1760000000-abcd 2>&1)"; rc=$?
if [[ $rc -ne 0 && "$out" == *REFUSED* && -d "$LOCK_DIR" ]]; then ok "unlock alive-runner refused"; else bad "unlock alive" "$out"; fi
printf '4242 (c) S 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 999 1\n' > "$PROC_ROOT/4242/stat"   # starttime changed = PID reused
out="$(v_deploy_unlock d1760000000-abcd 2>&1)"; rc=$?
if [[ $rc -eq 0 && ! -d "$LOCK_DIR" && -f "$STATE_DIR/keepme" ]]; then
  ok "unlock removes only fixed lock dir on proven-dead (PID reuse)"
else
  bad "unlock proven-dead" "rc=$rc out=$out"
fi

# ---------- T9: mask on error/status paths (no raw secrets escape) ----------
# Same verb|mask pipeline the gateway main uses; lib mode so the
# dev-machine node can read the state file.
cat > "$STATE_FILE" <<'EOF'
{"schema":1,"deployed_backend_sha":"a","previous_backend_sha":"b",
 "published_frontend_sha":"c","previous_frontend_sha":"d",
 "fe_release_dir":"postgresql://deploy:SuperSecretPW@db:5433/x"}
EOF
out="$(v_deploy_status 5 2>&1 | mask)"
if [[ "$out" == *'[MASKED]@'* && "$out" != *SuperSecretPW* ]]; then
  ok "deploy-status output masked (verb|mask pipeline)"
else
  bad "deploy-status mask" "$out"
fi
# And the full-invocation error path never leaks raw subprocess output:
out="$(SARGAS_DEPLOY_GW_LIB_ONLY= SSH_ORIGINAL_COMMAND="deploy-plan $SHA_A $SHA_B" bash "$GW" --test-root "$TMP" 2>&1)"
if [[ "$out" == *'-- error unreadable'* && "$out" == *'pinned binary missing'* ]]; then
  ok "plan error path: fixed diagnostic only"
else
  bad "plan error path" "$out"
fi

printf -- '---\n%d passed, %d failed\n' "$pass" "$failn"
exit $(( failn > 0 ? 1 : 0 ))
