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
# (Card 2: deploy-run is now a real verb; acceptance covered below)
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

if seed_delta "$R" "$BASE" "$PRESETS" >/dev/null; then ok "seed_delta presets change -> true"; else bad "seed_delta presets"; fi
if ! seed_delta "$R" "$PRESETS" "$README" >/dev/null; then ok "seed_delta readme-only -> false"; else bad "seed_delta readme-only"; fi
out="$(seed_delta "$R" "$README" "$EVIL")"
if [[ $? -eq 0 && "$out" == *import-guard*evil-helper* ]]; then ok "seed_delta import-guard fires"; else bad "seed_delta import-guard" "$out"; fi

# migration_delta on the fixture (none expected)
if [[ -z "$(migration_delta "$R" "$BASE" "$EVIL")" ]]; then ok "migration_delta none on fixture"; else bad "migration_delta fixture"; fi

# ---------- T6: state schema ----------
mkdir -p "$STATE_DIR"
cat > "$STATE_FILE" <<'EOF'
{"schema":1,"deployed_backend_sha":"x","previous_backend_sha":"y",
 "published_frontend_sha":"z","previous_frontend_sha":"w",
 "fe_release_dir":"/tmp/r","previous_fe_release_dir":"none"}
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
mkdir -p "$PROC_ROOT/4242" "$PROC_ROOT/self"   # self => identity "available" in the fake proc
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
 "fe_release_dir":"postgresql://deploy:SuperSecretPW@db:5433/x",
 "previous_fe_release_dir":"none"}
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

# =====================================================================
# Card 2 — detached runner scenarios in a hermetic fake world.
# =====================================================================
WT="$TMP/world"
CALLS="$WT/calls.log"
FLAGS="$WT/flags"

fake() { # fake <name> <body…reads $@, logs, obeys flags>
  cat > "$WT/bin/$1" <<EOF
#!/bin/bash
echo "$1 \$*" >> "$CALLS"
$2
exit 0
EOF
  chmod +x "$WT/bin/$1"
}

make_world() {
  mkdir -p "$WT/bin" "$WT/crm/fe-releases/initial" "$WT/.sargas-deploy/logs" "$FLAGS"
  ln -sf "$(command -v node)" "$WT/bin/node"
  ln -sf "$(command -v git)"  "$WT/bin/git"
  # NB: check for a timeout BINARY — `command -v` here would see the
  # lib-mode shim FUNCTION from the unit phase and skip the file.
  if [[ ! -x /usr/bin/timeout && ! -x /bin/timeout ]]; then
    printf '#!/bin/bash\nshift\nexec "$@"\n' > "$WT/bin/timeout"; chmod +x "$WT/bin/timeout"
  fi
  fake npm '
[ -e "'"$FLAGS"'/slow-npm" ] && sleep 2
case "$1 $2" in
  "ci --legacy-peer-deps") [ -e "'"$FLAGS"'/fail-fe-npm" ] && exit 1 ;;
  "ci ") [ -e "'"$FLAGS"'/fail-be-npm" ] && exit 1 ;;
  ci)    [ -e "'"$FLAGS"'/fail-be-npm" ] && exit 1 ;;
  "run build") [ -e "'"$FLAGS"'/fail-build" ] && exit 1 ;;
  "run seed:system") [ -e "'"$FLAGS"'/fail-seed" ] && exit 1; echo seeded ;;
esac'
  fake pm2 '
case "$1" in
  restart) [ -e "'"$FLAGS"'/fail-pm2" ] && exit 1 ;;
  jlist) echo "[]" ;;
esac'
  fake curl '
url="${!#}"
case "$url" in
  *3006*) if [ -e "'"$FLAGS"'/fail-health" ]; then echo -n 500; exit 22; fi
          n=$(cat "'"$FLAGS"'/hcount" 2>/dev/null || echo 0); n=$((n+1)); echo "$n" > "'"$FLAGS"'/hcount"
          if [ -e "'"$FLAGS"'/slow-health" ] && [ "$n" -lt 3 ]; then echo -n 000; exit 7; fi
          echo -n 200 ;;
  *) if [ -e "'"$FLAGS"'/fail-front-always" ]; then echo -n 500; exit 0; fi
     if [ -e "'"$FLAGS"'/fail-front" ]; then
       m=$(cat "'"$FLAGS"'/fcount" 2>/dev/null || echo 0); m=$((m+1)); echo "$m" > "'"$FLAGS"'/fcount"
       if [ "$m" -le 1 ]; then echo -n 500; exit 0; fi
     fi
     echo -n 200 ;;
esac'

  # --- backend fixture repo + bare origin ---
  BE="$WT/crm/sales-crm-backend"
  mkdir -p "$BE/prisma/migrations/0_init" "$BE/src/auth" "$BE/scripts" "$BE/node_modules/.bin"
  printf 'node_modules/\ndist/\n' > "$BE/.gitignore"
  printf '{"name":"be","scripts":{"build":"nest build","seed:system":"x"}}\n' > "$BE/package.json"
  printf 'export default {};\n' > "$BE/prisma.config.ts"
  printf 'CREATE TABLE "T" ("id" TEXT NOT NULL);\n' > "$BE/prisma/migrations/0_init/migration.sql"
  printf 'import "dotenv/config";\nimport { P } from "@prisma/client";\nimport { X } from "../src/auth/system-role-presets";\n' > "$BE/prisma/seed-system.ts"
  mv "$BE/prisma/seed-system.ts" "$BE/prisma/seed-system.ts"
  printf 'export const X = 1;\n' > "$BE/src/auth/system-role-presets.ts"
  printf '{}\n' > "$BE/prisma/tsconfig-seed.json"
  printf 'backup\n' > "$BE/scripts/backup.ts"
  printf 'gate\n' > "$BE/scripts/require-fresh-backup.ts"
  cat > "$BE/node_modules/.bin/prisma" <<EOF
#!/bin/bash
echo "prisma \$*" >> "$CALLS"
case "\$1 \$2" in
  "migrate deploy")
    [ -e "$FLAGS/fail-migrate" ] && exit 1
    touch "$FLAGS/db-applied" ;;
  "migrate status")
    [ -e "$FLAGS/db-failed" ] && { echo "The migration X failed"; exit 1; }
    # Model real prisma: pending migrations (files present in the
    # working tree but not applied) exit 1 with this phrasing.
    if [ -d prisma/migrations/1_add ] && [ ! -e "$FLAGS/db-applied" ]; then
      echo "Following migrations have not yet been applied: 1_add"
      exit 1
    fi
    echo "Database schema is up to date!" ;;
esac
exit 0
EOF
  cat > "$BE/node_modules/.bin/ts-node" <<EOF
#!/bin/bash
echo "ts-node \$*" >> "$CALLS"
case "\$*" in
  *backup.ts*)
    [ -e "$FLAGS/fail-backup" ] && { echo "DATABASE_URL=postgres://u:LEAKPW@h/db boom" >&2; exit 1; }
    st=VERIFIED; [ -e "$FLAGS/unverified" ] && st=UPLOADED
    printf '{ "ok": true, "id": "run-0001", "status": "%s", "artifactKey": "pre/x.dump", "size": 10, "checksum": "abc123" }\n' "\$st" ;;
  *require-fresh-backup.ts*)
    [ -e "$FLAGS/fail-gate" ] && exit 1 ;;
esac
exit 0
EOF
  chmod +x "$BE/node_modules/.bin/prisma" "$BE/node_modules/.bin/ts-node"
  git -C "$BE" init -q -b main; git -C "$BE" config user.email t@t; git -C "$BE" config user.name t
  git -C "$BE" add -A; git -C "$BE" commit -qm base
  BASE_BE="$(git -C "$BE" rev-parse HEAD)"
  printf 'code2\n' > "$BE/src/code.ts"; git -C "$BE" add -A; git -C "$BE" commit -qm code
  SHA_CODE="$(git -C "$BE" rev-parse HEAD)"
  mkdir -p "$BE/prisma/migrations/1_add"
  printf 'ALTER TABLE "T" ADD COLUMN "c" TEXT;\n' > "$BE/prisma/migrations/1_add/migration.sql"
  git -C "$BE" add -A; git -C "$BE" commit -qm mig
  SHA_MIG="$(git -C "$BE" rev-parse HEAD)"
  mkdir -p "$BE/prisma/migrations/2_drop"
  printf 'DROP TABLE "T";\n' > "$BE/prisma/migrations/2_drop/migration.sql"
  git -C "$BE" add -A; git -C "$BE" commit -qm drop
  SHA_MANUAL="$(git -C "$BE" rev-parse HEAD)"
  git -C "$BE" reset -q --hard "$SHA_CODE"
  printf 'export const X = 2;\n' > "$BE/src/auth/system-role-presets.ts"
  git -C "$BE" add -A; git -C "$BE" commit -qm seed
  SHA_SEED="$(git -C "$BE" rev-parse HEAD)"
  git -C "$BE" reset -q --hard "$BASE_BE"
  git clone -q --bare "$BE" "$WT/be-origin.git"
  git -C "$BE" remote add origin "$WT/be-origin.git"

  # --- frontend fixture repo + bare origin ---
  FE="$WT/crm/sales-crm-frontend"
  mkdir -p "$FE/src" "$FE/node_modules/.bin"
  printf 'node_modules/\ndist\n' > "$FE/.gitignore"
  printf '{"name":"fe","scripts":{"build:strict":"tsc && vite build"}}\n' > "$FE/package.json"
  printf 'export default {};\n' > "$FE/vite.config.ts"
  printf 'ui1\n' > "$FE/src/app.tsx"
  cat > "$FE/node_modules/.bin/tsc" <<EOF
#!/bin/bash
echo "tsc \$*" >> "$CALLS"
[ -e "$FLAGS/fail-tsc" ] && exit 1
exit 0
EOF
  cat > "$FE/node_modules/.bin/vite" <<EOF
#!/bin/bash
echo "vite \$*" >> "$CALLS"
[ -e "$FLAGS/fail-vite" ] && exit 1
out=""
while [ \$# -gt 0 ]; do [ "\$1" = "--outDir" ] && out="\$2"; shift; done
mkdir -p "\$out/assets"
echo hi > "\$out/index.html"
[ -e "$FLAGS/empty-assets" ] || echo js > "\$out/assets/app.js"
exit 0
EOF
  chmod +x "$FE/node_modules/.bin/tsc" "$FE/node_modules/.bin/vite"
  git -C "$FE" init -q -b main; git -C "$FE" config user.email t@t; git -C "$FE" config user.name t
  git -C "$FE" add -A; git -C "$FE" commit -qm base
  BASE_FE="$(git -C "$FE" rev-parse HEAD)"
  printf 'ui2\n' > "$FE/src/app.tsx"; git -C "$FE" add -A; git -C "$FE" commit -qm ui
  SHA_FE="$(git -C "$FE" rev-parse HEAD)"
  git -C "$FE" reset -q --hard "$BASE_FE"
  git clone -q --bare "$FE" "$WT/fe-origin.git"
  git -C "$FE" remote add origin "$WT/fe-origin.git"
  echo seed > "$WT/crm/fe-releases/initial/index.html"
  ln -s "$WT/crm/fe-releases/initial" "$FE/dist"
}

WSTATE="$WT/.sargas-deploy/state.json"
set_tips() { git -C "$WT/be-origin.git" update-ref refs/heads/main "$1"
             git -C "$WT/fe-origin.git" update-ref refs/heads/main "$2"; }
reset_world() { # <be-tip> <fe-tip>
  # Kill any runner still alive from a previous scenario before
  # tearing its world down under it.
  local lp
  lp="$(grep '^PID=' "$WT/.sargas-deploy/lock/meta" 2>/dev/null | cut -d= -f2)"
  if [[ "$lp" =~ ^[0-9]+$ ]] && kill -0 "$lp" 2>/dev/null; then
    kill -9 "$lp" 2>/dev/null; sleep 0.3
  fi
  rm -rf "$FLAGS"; mkdir -p "$FLAGS"
  : > "$CALLS"
  rm -rf "$WT/.sargas-deploy/lock" "$WT/.sargas-deploy/logs"; mkdir -p "$WT/.sargas-deploy/logs"
  git -C "$BE" reset -q --hard "$BASE_BE"
  git -C "$FE" reset -q --hard "$BASE_FE"
  rm -rf "$WT/crm/fe-releases"; mkdir -p "$WT/crm/fe-releases/initial"
  echo seed > "$WT/crm/fe-releases/initial/index.html"
  rm -rf "$FE/dist"; ln -s "$WT/crm/fe-releases/initial" "$FE/dist"
  cat > "$WSTATE" <<EOF
{"schema":1,"deployed_backend_sha":"$BASE_BE","previous_backend_sha":"none",
 "published_frontend_sha":"$BASE_FE","previous_frontend_sha":"none",
 "fe_release_dir":"$WT/crm/fe-releases/initial","previous_fe_release_dir":"none"}
EOF
  set_tips "$1" "$2"
}
w() { SARGAS_DEPLOY_GW_LIB_ONLY= SSH_ORIGINAL_COMMAND="$1" bash "$GW" --test-root "$WT" 2>&1; }
wait_done() { # wait until lock gone or FAILED; prints journal tail on timeout
  local i=0
  while (( i < 50 )); do
    [[ ! -d "$WT/.sargas-deploy/lock" ]] && return 0
    grep -q 'FAILED@' "$WT"/.sargas-deploy/logs/*.log 2>/dev/null && return 0
    sleep 0.3; i=$((i+1))
  done
  return 1
}
sget() { SARGAS_DEPLOY_GW_LIB_ONLY=1 PROC_ROOT= bash -c "source '$GW' --test-root '$WT'; state_get $1"; }
order_ok() { # order_ok <needle1> <needle2> — needle1 line appears before needle2
  local a b
  a=$(grep -n "$1" "$CALLS" | head -1 | cut -d: -f1); b=$(grep -n "$2" "$CALLS" | head -1 | cut -d: -f1)
  [[ -n "$a" && -n "$b" && "$a" -lt "$b" ]]
}
t2() { if eval "$2"; then ok "S:$1"; else bad "S:$1"; fi; }

make_world

# --- S1 code-only happy path + detach + order ---
reset_world "$SHA_CODE" "$SHA_FE"
out="$(w "deploy-run $SHA_CODE $SHA_FE")"; rc=$?
t2 'run returns deploy-id, exit 0' '[[ $rc -eq 0 && "$out" == *deploy-id:* ]]'
RID="$(sed -n 's/^deploy-id: //p' <<<"$out")"
pid="$(grep '^PID=' "$WT/.sargas-deploy/lock/meta" 2>/dev/null | cut -d= -f2)"
t2 'runner alive after dispatcher exit' '[[ -n "$pid" ]] && kill -0 "$pid" 2>/dev/null || [[ ! -d "$WT/.sargas-deploy/lock" ]]'
wait_done; t2 'S1 finishes' '[[ ! -d "$WT/.sargas-deploy/lock" ]]'
J="$WT/.sargas-deploy/logs/$RID.log"
t2 'S1 DEPLOYED'            'grep -q "^DEPLOYED$" "$J"'
t2 'S1 no db calls'         '! grep -qE "ts-node .*backup|migrate deploy|seed:system" "$CALLS"'
t2 'S1 order be-ci<build'   'order_ok "npm ci" "npm run build"'
t2 'S1 order build<pm2'     'order_ok "npm run build" "pm2 restart sales-crm-back-end"'
t2 'S1 order pm2<fe-ci'     'order_ok "pm2 restart" "npm ci --legacy-peer-deps"'
t2 'S1 order tsc<vite'      'order_ok "^tsc" "^vite build"'
t2 'S1 state deployed'      '[[ "$(sget deployed_backend_sha)" == "$SHA_CODE" ]]'
t2 'S1 state published'     '[[ "$(sget published_frontend_sha)" == "$SHA_FE" ]]'
t2 'S1 dist swapped'        '[[ "$(readlink "$FE/dist")" == "$WT/crm/fe-releases/$RID" ]]'

# --- S1c regression: external umask 077 must still yield an nginx-readable release ---
perm() { stat -f '%Lp' "$1" 2>/dev/null || stat -c '%a' "$1" 2>/dev/null; }
reset_world "$SHA_CODE" "$SHA_FE"
( umask 077; w "deploy-run $SHA_CODE $SHA_FE" >/dev/null )
wait_done
REL1C="$(readlink "$FE/dist")"
t2 'S1c deployed under umask 077' 'grep -q "^DEPLOYED$" "$WT/.sargas-deploy/logs/"*.log'
t2 'S1c release dir 755'   '[[ "$(perm "$REL1C")" == 755 ]]'
t2 'S1c index.html 644'    '[[ "$(perm "$REL1C/index.html")" == 644 ]]'
t2 'S1c asset 644'         '[[ "$(perm "$REL1C/assets/app.js")" == 644 ]]'

# --- S2 migration path: backup before first DB write ---
reset_world "$SHA_MIG" "$SHA_FE"
w "deploy-run $SHA_MIG $SHA_FE" >/dev/null; wait_done
t2 'S2 backup present'      'grep -q "ts-node scripts/backup.ts" "$CALLS"'
t2 'S2 gate present'        'grep -q "require-fresh-backup.ts --pre-migration --current-run-id=run-0001" "$CALLS"'
t2 'S2 backup<gate<migrate' 'order_ok "backup.ts" "require-fresh-backup" && order_ok "require-fresh-backup" "migrate deploy"'
t2 'S2 migrate<restart'     'order_ok "migrate deploy" "pm2 restart"'
t2 'S2 done'                'grep -q "^DEPLOYED$" "$WT/.sargas-deploy/logs/"*.log'

# --- S3 seed-only: backup+gate, no migrate, seed runs ---
reset_world "$SHA_SEED" "$SHA_FE"
w "deploy-run $SHA_SEED $SHA_FE" >/dev/null; wait_done
t2 'S3 backup present'      'grep -q "backup.ts" "$CALLS"'
t2 'S3 no migrate deploy'   '! grep -q "migrate deploy" "$CALLS"'
t2 'S3 seed ran'            'grep -q "npm run seed:system" "$CALLS"'
t2 'S3 backup<seed'         'order_ok "backup.ts" "seed:system"'

# --- S4 backup failure: no DB writes, lock held, mask on journal ---
reset_world "$SHA_MIG" "$SHA_FE"
touch "$FLAGS/fail-backup"
w "deploy-run $SHA_MIG $SHA_FE" >/dev/null; wait_done
t2 'S4 failed at backup'    'grep -q "FAILED@4-backup" "$WT/.sargas-deploy/logs/"*.log'
t2 'S4 no migrate/seed'     '! grep -qE "migrate deploy|seed:system" "$CALLS"'
t2 'S4 lock held'           '[[ -d "$WT/.sargas-deploy/lock" ]]'
t2 'S4 deployed unchanged'  '[[ "$(sget deployed_backend_sha)" == "$BASE_BE" ]]'
t2 'S4 journal masked'      '! grep -q "LEAKPW" "$WT/.sargas-deploy/logs/"*.log && grep -q "\[MASKED\]" "$WT/.sargas-deploy/logs/"*.log'
RID4="$(grep '^DEPLOY_ID=' "$WT/.sargas-deploy/lock/meta" | cut -d= -f2)"
out="$(w "deploy-unlock $RID4")"
t2 'S4 unlock after dead'   '[[ "$out" == *removed* && ! -d "$WT/.sargas-deploy/lock" ]]'

# --- S4b unverified backup blocks ---
reset_world "$SHA_MIG" "$SHA_FE"
touch "$FLAGS/unverified"
w "deploy-run $SHA_MIG $SHA_FE" >/dev/null; wait_done
t2 'S4b UPLOADED blocked'   'grep -q "not VERIFIED" "$WT/.sargas-deploy/logs/"*.log && ! grep -q "migrate deploy" "$CALLS"'

# --- S5 manual migration refused pre-lock ---
reset_world "$SHA_MANUAL" "$SHA_FE"
out="$(w "deploy-run $SHA_MANUAL $SHA_FE")"; rc=$?
t2 'S5 refused'             '[[ $rc -ne 0 && "$out" == *manual-required* ]]'
t2 'S5 no lock, no runner'  '[[ ! -d "$WT/.sargas-deploy/lock" ]] && ! grep -q "npm ci" "$CALLS"'

# --- S6 be npm-ci fail then retry completes ---
reset_world "$SHA_MIG" "$SHA_FE"
touch "$FLAGS/fail-be-npm"
w "deploy-run $SHA_MIG $SHA_FE" >/dev/null; wait_done
t2 'S6 failed at be-npm'    'grep -q "FAILED@3-be-npm-ci" "$WT/.sargas-deploy/logs/"*.log'
t2 'S6 pm2 not called'      '! grep -q "pm2 restart" "$CALLS"'
RID6="$(grep '^DEPLOY_ID=' "$WT/.sargas-deploy/lock/meta" | cut -d= -f2)"
rm -f "$FLAGS/fail-be-npm"; w "deploy-unlock $RID6" >/dev/null
rm -f "$WT/.sargas-deploy/logs/"*.log
w "deploy-run $SHA_MIG $SHA_FE" >/dev/null; wait_done
t2 'S6 retry deployed'      '[[ "$(sget deployed_backend_sha)" == "$SHA_MIG" ]] && grep -q "^DEPLOYED$" "$WT/.sargas-deploy/logs/"*.log'

# --- S8 health fail: frontend untouched, deployed NOT advanced ---
reset_world "$SHA_CODE" "$SHA_FE"
touch "$FLAGS/fail-health"
w "deploy-run $SHA_CODE $SHA_FE" >/dev/null; wait_done
t2 'S8 failed at health'    'grep -q "FAILED@9-health" "$WT/.sargas-deploy/logs/"*.log'
t2 'S8 fe not touched'      '! grep -qE "legacy-peer-deps|^vite" "$CALLS"'
t2 'S8 deployed not set'    '[[ "$(sget deployed_backend_sha)" == "$BASE_BE" ]]'
t2 'S8 dist unchanged'      '[[ "$(readlink "$FE/dist")" == "$WT/crm/fe-releases/initial" ]]'

# --- S8b slow health: polling succeeds ---
reset_world "$SHA_CODE" "$SHA_FE"
touch "$FLAGS/slow-health"
w "deploy-run $SHA_CODE $SHA_FE" >/dev/null; wait_done
t2 'S8b poll then deployed' 'grep -q "^DEPLOYED$" "$WT/.sargas-deploy/logs/"*.log && [[ "$(cat "$FLAGS/hcount")" -ge 3 ]]'

# --- S9 fe tsc fail: dist unchanged; retry finishes without re-backup ---
reset_world "$SHA_MIG" "$SHA_FE"
touch "$FLAGS/fail-tsc"
w "deploy-run $SHA_MIG $SHA_FE" >/dev/null; wait_done
t2 'S9 failed at tsc'       'grep -q "FAILED@11-fe-tsc" "$WT/.sargas-deploy/logs/"*.log'
t2 'S9 backend committed'   '[[ "$(sget deployed_backend_sha)" == "$SHA_MIG" ]]'
t2 'S9 dist unchanged'      '[[ "$(readlink "$FE/dist")" == "$WT/crm/fe-releases/initial" ]]'
t2 'S9 published old'       '[[ "$(sget published_frontend_sha)" == "$BASE_FE" ]]'
RID9="$(grep '^DEPLOY_ID=' "$WT/.sargas-deploy/lock/meta" | cut -d= -f2)"
rm -f "$FLAGS/fail-tsc"; w "deploy-unlock $RID9" >/dev/null; : > "$CALLS"
rm -f "$WT/.sargas-deploy/logs/"*.log
w "deploy-run $SHA_MIG $SHA_FE" >/dev/null; wait_done
t2 'S9 retry no 2nd backup' '! grep -q "backup.ts" "$CALLS"'
t2 'S9 retry published'     '[[ "$(sget published_frontend_sha)" == "$SHA_FE" ]]'

# --- S10 vite fail / S11 empty assets: dist never changes ---
reset_world "$SHA_CODE" "$SHA_FE"; touch "$FLAGS/fail-vite"
w "deploy-run $SHA_CODE $SHA_FE" >/dev/null; wait_done
t2 'S10 dist unchanged'     '[[ "$(readlink "$FE/dist")" == "$WT/crm/fe-releases/initial" ]]'
reset_world "$SHA_CODE" "$SHA_FE"; touch "$FLAGS/empty-assets"
w "deploy-run $SHA_CODE $SHA_FE" >/dev/null; wait_done
t2 'S11 artifacts blocked'  'grep -q "FAILED@12-fe-artifacts" "$WT/.sargas-deploy/logs/"*.log && [[ "$(readlink "$FE/dist")" == "$WT/crm/fe-releases/initial" ]]'

# --- S12 front health fail after swap: honest state, retry completes ---
reset_world "$SHA_CODE" "$SHA_FE"; touch "$FLAGS/fail-front"
w "deploy-run $SHA_CODE $SHA_FE" >/dev/null; wait_done
t2 'S12 failed at fe-health' 'grep -q "FAILED@14-fe-health" "$WT/.sargas-deploy/logs/"*.log'
t2 'S12 published not set'   '[[ "$(sget published_frontend_sha)" == "$BASE_FE" ]]'
t2 'S12 rolled back to previous' '[[ "$(realpath "$FE/dist")" == "$(realpath "$WT/crm/fe-releases/initial")" ]]'
t2 'S12 rollback journaled'  'grep -q "rolled back" "$WT/.sargas-deploy/logs/"*.log'
t2 'S12 post-rollback probe 200' 'grep -q "post-rollback probe: 200" "$WT/.sargas-deploy/logs/"*.log'
t2 'S12 new release retained' '[[ "$(ls -1 "$WT/crm/fe-releases" | grep -c "^d")" -eq 1 ]]'
t2 'S12 retention skipped'   '! grep -q "15-prune" "$WT/.sargas-deploy/logs/"*.log'
RID12="$(grep '^DEPLOY_ID=' "$WT/.sargas-deploy/lock/meta" | cut -d= -f2)"
rm -f "$FLAGS/fail-front"; w "deploy-unlock $RID12" >/dev/null
rm -f "$WT/.sargas-deploy/logs/"*.log
w "deploy-run $SHA_CODE $SHA_FE" >/dev/null; wait_done
t2 'S12 retry published'     '[[ "$(sget published_frontend_sha)" == "$SHA_FE" ]]'

# --- S12b post-swap probe fails AND stays failing: manual intervention ---
reset_world "$SHA_CODE" "$SHA_FE"
touch "$FLAGS/fail-front-always"
w "deploy-run $SHA_CODE $SHA_FE" >/dev/null; wait_done
t2 'S12b manual-intervention marked' 'grep -q "MANUAL-INTERVENTION-REQUIRED" "$WT/.sargas-deploy/logs/"*.log'
t2 'S12b step marked in meta' 'grep -q "STEP=14-fe-health-MANUAL-INTERVENTION" "$WT/.sargas-deploy/lock/meta"'
t2 'S12b lock held'          '[[ -d "$WT/.sargas-deploy/lock" ]]'
t2 'S12b dist back on previous (swap-back done, probe still down)' '[[ "$(realpath "$FE/dist")" == "$(realpath "$WT/crm/fe-releases/initial")" ]]'
t2 'S12b both releases retained' '[[ -d "$WT/crm/fe-releases/initial" && "$(ls -1 "$WT/crm/fe-releases" | grep -c "^d")" -eq 1 ]]'
t2 'S12b published untouched' '[[ "$(sget published_frontend_sha)" == "$BASE_FE" ]]'

# --- S13 malicious dist symlink: refused before lock ---
reset_world "$SHA_CODE" "$SHA_FE"
rm -f "$FE/dist"; ln -s /tmp "$FE/dist"
out="$(w "deploy-run $SHA_CODE $SHA_FE")"; rc=$?
t2 'S13 outside-releases refused pre-lock' '[[ $rc -ne 0 && "$out" == *outside* && ! -d "$WT/.sargas-deploy/lock" ]]'
rm -f "$FE/dist"; rm -rf "$FE/dist"; mkdir "$FE/dist"
out="$(w "deploy-run $SHA_CODE $SHA_FE")"; rc=$?
t2 'S13b non-symlink dist refused' '[[ $rc -ne 0 && "$out" == *"not a symlink"* ]]'

# --- S14 concurrency + live-lock protection ---
reset_world "$SHA_CODE" "$SHA_FE"
touch "$FLAGS/slow-npm"   # widen the live-lock window deterministically
w "deploy-run $SHA_CODE $SHA_FE" >/dev/null
out2="$(w "deploy-run $SHA_CODE $SHA_FE")"; rc2=$?
t2 'S14 second run refused' '[[ $rc2 -ne 0 && "$out2" == *"holds the lock"* ]]'
RIDL="$(grep '^DEPLOY_ID=' "$WT/.sargas-deploy/lock/meta" 2>/dev/null | cut -d= -f2)"
out3="$(w "deploy-unlock $RIDL")"
t2 'S14 unlock refused while alive' '[[ "$out3" == *REFUSED* && -d "$WT/.sargas-deploy/lock" ]]'
wait_done
t2 'S14 eventually done'    '[[ ! -d "$WT/.sargas-deploy/lock" ]]'

# --- S15 retention: keep current+previous+3 newest ---
reset_world "$SHA_CODE" "$SHA_FE"
for i in 1 2 3 4 5; do mkdir -p "$WT/crm/fe-releases/d170000000$i-aaaa"; done
touch -t 202601010001 "$WT/crm/fe-releases/d1700000001-aaaa" 2>/dev/null || true
w "deploy-run $SHA_CODE $SHA_FE" >/dev/null; wait_done
live="$(ls -1 "$WT/crm/fe-releases" | sort)"
t2 'S15 initial kept'       'grep -q "^initial$" <<<"$live"'
cnt17="$(grep -c "^d17" <<<"$live")"
t2 "S15 pruned to limit (d17*=$cnt17)" '[[ "$cnt17" -le 4 ]]'   # 3 newest + maybe previous pattern
t2 'S15 current kept'       'grep -q "$(basename "$(readlink "$FE/dist")")" <<<"$live"'

# --- S17 state file is atomic under kill -9 ---
reset_world "$SHA_CODE" "$SHA_FE"
touch "$FLAGS/slow-health"
w "deploy-run $SHA_CODE $SHA_FE" >/dev/null
pidk="$(grep '^PID=' "$WT/.sargas-deploy/lock/meta" 2>/dev/null | cut -d= -f2)"
[[ -n "$pidk" ]] && kill -9 "$pidk" 2>/dev/null
sleep 0.5
t2 'S17 state still parses' 'sget schema >/dev/null'
RIDK="$(grep '^DEPLOY_ID=' "$WT/.sargas-deploy/lock/meta" 2>/dev/null | cut -d= -f2)"
[[ -n "$RIDK" ]] && w "deploy-unlock $RIDK" >/dev/null

# --- S18 real-prisma pending semantics: transient post-ff failure, retry allowed ---
reset_world "$SHA_MIG" "$SHA_FE"
touch "$FLAGS/fail-build"
w "deploy-run $SHA_MIG $SHA_FE" >/dev/null; wait_done
t2 'S18 failed at build (post-ff, pre-migrate)' 'grep -q "FAILED@3-be-build" "$WT/.sargas-deploy/logs/"*.log'
RID18="$(grep '^DEPLOY_ID=' "$WT/.sargas-deploy/lock/meta" | cut -d= -f2)"
rm -f "$FLAGS/fail-build"; w "deploy-unlock $RID18" >/dev/null
out="$(w "deploy-plan $SHA_MIG $SHA_FE")"
t2 'S18 retry plan allows pending' '[[ "$out" == *"pending migrations consistent with a retry"* ]]'
rm -f "$WT/.sargas-deploy/logs/"*.log
w "deploy-run $SHA_MIG $SHA_FE" >/dev/null; wait_done
t2 'S18 retry deploys'      '[[ "$(sget deployed_backend_sha)" == "$SHA_MIG" ]] && grep -q "^DEPLOYED$" "$WT/.sargas-deploy/logs/"*.log'

# --- S18b failed migration recorded in DB: always blocked (manual path C) ---
reset_world "$SHA_MIG" "$SHA_FE"
touch "$FLAGS/db-failed"
out="$(w "deploy-run $SHA_MIG $SHA_FE")"; rc=$?
t2 'S18b failed-migration blocks pre-lock' '[[ $rc -ne 0 && "$out" == *"manual path C"* && ! -d "$WT/.sargas-deploy/lock" ]]'

# --- grammar additions for deploy-run (Card 1 regressions re-covered) ---
g 'deploy-run one sha'     2 "deploy-run $SHA_A"
g 'deploy-run trailer'     2 "deploy-run $SHA_A $SHA_B x"
g 'deploy-run bad hex'     2 "deploy-run ${SHA_A:0:39}g $SHA_B"
g 'bare deploy-run'        2 'deploy-run'
g 'ACCEPT deploy-run empty world -> unreadable' 1 "deploy-run $SHA_A $SHA_B"

printf -- '---\n%d passed, %d failed\n' "$pass" "$failn"
exit $(( failn > 0 ? 1 : 0 ))
