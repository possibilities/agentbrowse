#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
ROOT="$(cd "$SCRIPT_DIR/.." && pwd -P)"
SOURCE="$ROOT/cli/main.ts"
BIN_DIR="${AGENTBROWSE_INSTALL_BIN_DIR:-$HOME/.local/bin}"
STATE_DIR="${AGENTBROWSE_INSTALL_STATE_DIR:-$HOME/.local/state/agentbrowse}"
TARGET="$BIN_DIR/agentbrowse"
RECEIPT="$STATE_DIR/deployed-sha"
UPSTREAM_ORIGIN="https://github.com/possibilities/agentbrowse.git"
EXPECTED_ORIGIN="${AGENTBROWSE_INSTALL_EXPECTED_ORIGIN:-$UPSTREAM_ORIGIN}"
TMP_PATH=""

cleanup() {
  if [[ -n "$TMP_PATH" ]]; then
    rm -f -- "$TMP_PATH"
  fi
}
trap cleanup EXIT

usage() {
  cat <<'USAGE'
Usage: scripts/install.sh [--install|--uninstall|--help]

With no option, installs agentbrowse. Installation runs Bun's frozen dependency
install, links ~/.local/bin/agentbrowse to this checkout, and writes the deployed
Git SHA to ~/.local/state/agentbrowse/deployed-sha.

Set AGENTBROWSE_INSTALL_BIN_DIR and AGENTBROWSE_INSTALL_STATE_DIR to use other
locations, including for hermetic tests.
USAGE
}

die() {
  printf 'agentbrowse installer: %s\n' "$1" >&2
  exit "${2:-1}"
}

owner_uid() {
  stat -c %u "$1" 2>/dev/null || stat -f %u "$1"
}

file_mode() {
  stat -c %a "$1" 2>/dev/null || stat -f %Lp "$1"
}

file_nlink() {
  stat -c %h "$1" 2>/dev/null || stat -f %l "$1"
}

validate_path() {
  local path="$1"
  local label="$2"
  local component current="" remainder platform

  [[ -n "$path" && "$path" == /* ]] || die "refusing unsafe $label path (must be absolute): $path"
  [[ "$path" != "/" && "$path" != *//* && "$path" != */./* && "$path" != */../* && "$path" != */. && "$path" != */.. ]] || \
    die "refusing unsafe $label path: $path"

  platform="$(uname -s)"
  remainder="${path#/}"
  while [[ -n "$remainder" ]]; do
    component="${remainder%%/*}"
    current="$current/$component"
    if [[ "$remainder" == */* ]]; then
      remainder="${remainder#*/}"
    else
      remainder=""
    fi

    if [[ "$platform" == "Darwin" ]]; then
      case "$current:$(readlink "$current" 2>/dev/null || true)" in
        /tmp:private/tmp|/tmp:/private/tmp|/var:private/var|/var:/private/var)
          continue
          ;;
      esac
    fi
    [[ ! -L "$current" ]] || die "refusing symlinked $label path component: $current"
  done
}

validate_directory() {
  local dir="$1"
  local label="$2"
  local mode mode_value

  validate_path "$dir" "$label"
  [[ -d "$dir" ]] || die "refusing non-directory $label path: $dir"
  [[ "$(owner_uid "$dir")" == "$(id -u)" ]] || die "refusing foreign $label directory: $dir"
  mode="$(file_mode "$dir")"
  [[ "$mode" =~ ^[0-7]{3,4}$ ]] || die "could not validate permissions for $label directory: $dir"
  mode_value=$((8#$mode))
  (( (mode_value & 0022) == 0 )) || die "refusing unsafe writable $label directory: $dir"
}

ensure_directory() {
  local dir="$1"
  local label="$2"
  local create_mode="$3"

  validate_path "$dir" "$label"
  if [[ -e "$dir" ]]; then
    [[ -d "$dir" ]] || die "refusing non-directory $label path: $dir"
  else
    mkdir -p -- "$dir"
    chmod "$create_mode" "$dir"
  fi
  validate_directory "$dir" "$label"
}

validate_safe_file() {
  local path="$1"
  local label="$2"
  local mode mode_value

  [[ ! -L "$path" && -f "$path" ]] || die "refusing unsafe $label: $path"
  [[ "$(owner_uid "$path")" == "$(id -u)" ]] || die "refusing foreign $label: $path"
  mode="$(file_mode "$path")"
  [[ "$mode" =~ ^[0-7]{3,4}$ ]] || die "could not validate permissions for $label: $path"
  mode_value=$((8#$mode))
  (( (mode_value & 0022) == 0 )) || die "refusing unsafe writable $label: $path"
}

checkout_head() {
  local root="$1"
  local physical_root top sha

  [[ -d "$root/.git" || -f "$root/.git" ]] || return 1
  physical_root="$(cd "$root" && pwd -P)" || return 1
  top="$(git -C "$root" rev-parse --show-toplevel 2>/dev/null)" || return 1
  [[ "$top" == "$physical_root" ]] || return 1
  sha="$(git -C "$root" rev-parse --verify HEAD 2>/dev/null)" || return 1
  [[ "$sha" =~ ^[0-9a-f]{40}$ ]] || return 1
  printf '%s\n' "$sha"
}

normalized_origin() {
  local origin="$1"
  origin="${origin%/}"
  case "$origin" in
    https://github.com/possibilities/agentbrowse|https://github.com/possibilities/agentbrowse.git|git@github.com:possibilities/agentbrowse|git@github.com:possibilities/agentbrowse.git|ssh://git@github.com/possibilities/agentbrowse|ssh://git@github.com/possibilities/agentbrowse.git)
      printf '%s\n' "$UPSTREAM_ORIGIN"
      ;;
    *)
      printf '%s\n' "$origin"
      ;;
  esac
}

validate_managed_checkout() {
  local root="$1"
  local source="$root/cli/main.ts"
  local origin sha

  [[ "$root" == /* ]] || die "refusing managed command with a non-absolute source root: $root"
  validate_path "$root" "source root"
  validate_directory "$root" "source root"
  validate_safe_file "$source" "agentbrowse source command"
  [[ -x "$source" ]] || die "refusing non-executable agentbrowse source command: $source"
  sha="$(checkout_head "$root")" || die "refusing agentbrowse source outside an exact Git checkout: $root"
  origin="$(git -C "$root" remote get-url origin 2>/dev/null)" || die "refusing agentbrowse source without an origin: $root"
  [[ "$(normalized_origin "$origin")" == "$EXPECTED_ORIGIN" ]] || die "refusing agentbrowse source with foreign origin: $root"
  MANAGED_ROOT="$root"
  MANAGED_SHA="$sha"
}

classify_command() {
  local destination root
  MANAGED_KIND="absent"
  MANAGED_ROOT=""
  MANAGED_SHA=""

  if [[ ! -e "$TARGET" && ! -L "$TARGET" ]]; then
    return 0
  fi
  [[ -L "$TARGET" ]] || die "refusing foreign command path: $TARGET"
  [[ "$(owner_uid "$TARGET")" == "$(id -u)" ]] || die "refusing foreign command symlink: $TARGET"
  destination="$(readlink "$TARGET")"
  [[ "$destination" == /*/cli/main.ts ]] || die "refusing foreign command symlink: $TARGET"
  root="${destination%/cli/main.ts}"
  [[ "$destination" == "$root/cli/main.ts" ]] || die "refusing foreign command symlink: $TARGET"
  validate_managed_checkout "$root"
  MANAGED_KIND="source-link"
}

validate_receipt() {
  local expected_sha="${1:-}"
  local sha

  [[ ! -L "$RECEIPT" && -f "$RECEIPT" ]] || die "refusing unsafe deployed receipt: $RECEIPT"
  [[ "$(owner_uid "$RECEIPT")" == "$(id -u)" ]] || die "refusing foreign deployed receipt: $RECEIPT"
  [[ "$(file_nlink "$RECEIPT")" == "1" ]] || die "refusing hardlinked deployed receipt: $RECEIPT"
  [[ "$(file_mode "$RECEIPT")" == "600" ]] || die "refusing deployed receipt with unsafe permissions: $RECEIPT"
  IFS= read -r sha <"$RECEIPT" || die "refusing malformed deployed receipt: $RECEIPT"
  [[ "$sha" =~ ^[0-9a-f]{40}$ ]] || die "refusing malformed deployed receipt: $RECEIPT"
  printf '%s\n' "$sha" | cmp -s - "$RECEIPT" || die "refusing malformed deployed receipt: $RECEIPT"
  if [[ -n "$expected_sha" && "$sha" != "$expected_sha" ]]; then
    die "refusing deployed receipt that does not match the managed command: $RECEIPT"
  fi
}

receipt_exists() {
  [[ -e "$RECEIPT" || -L "$RECEIPT" ]]
}

install_agentbrowse() {
  local sha

  command -v bun >/dev/null 2>&1 || die "Bun is required but was not found in PATH"
  validate_managed_checkout "$ROOT"
  sha="$MANAGED_SHA"
  ensure_directory "$BIN_DIR" "bin" 755
  ensure_directory "$STATE_DIR" "state" 700
  classify_command
  if receipt_exists; then
    [[ "$MANAGED_KIND" != "absent" ]] || die "refusing an uncorroborated deployed receipt: $RECEIPT"
    if [[ "$MANAGED_ROOT" == "$ROOT" && "$MANAGED_SHA" == "$sha" ]]; then
      validate_receipt
    else
      validate_receipt "$MANAGED_SHA"
    fi
  fi

  (cd "$ROOT" && bun install --frozen-lockfile)

  TMP_PATH="$BIN_DIR/.agentbrowse-link.$$.$RANDOM"
  [[ ! -e "$TMP_PATH" && ! -L "$TMP_PATH" ]] || die "refusing unsafe temporary command path: $TMP_PATH"
  ln -s -- "$SOURCE" "$TMP_PATH"
  mv -f -- "$TMP_PATH" "$TARGET"
  TMP_PATH=""
  [[ -L "$TARGET" && "$(readlink "$TARGET")" == "$SOURCE" ]] || die "installed command failed verification: $TARGET"

  TMP_PATH="$(mktemp "$STATE_DIR/.deployed-sha.XXXXXX")"
  chmod 0600 "$TMP_PATH"
  printf '%s\n' "$sha" >"$TMP_PATH"
  [[ ! -L "$TMP_PATH" && -f "$TMP_PATH" && "$(owner_uid "$TMP_PATH")" == "$(id -u)" && "$(file_nlink "$TMP_PATH")" == "1" && "$(file_mode "$TMP_PATH")" == "600" ]] || \
    die "temporary deployed receipt failed verification"
  mv -f -- "$TMP_PATH" "$RECEIPT"
  TMP_PATH=""
  validate_receipt "$sha"
  printf 'Installed %s at %s\n' "$TARGET" "$sha"
}

uninstall_agentbrowse() {
  local have_state=0 removed=0

  validate_path "$BIN_DIR" "bin"
  validate_path "$STATE_DIR" "state"
  if [[ -e "$BIN_DIR" ]]; then validate_directory "$BIN_DIR" "bin"; fi
  if [[ -e "$STATE_DIR" ]]; then validate_directory "$STATE_DIR" "state"; have_state=1; fi
  classify_command
  if receipt_exists; then
    [[ "$MANAGED_KIND" != "absent" ]] || die "refusing an uncorroborated deployed receipt: $RECEIPT"
    validate_receipt "$MANAGED_SHA"
  fi
  if [[ "$MANAGED_KIND" != "absent" ]]; then rm -f -- "$TARGET"; removed=1; fi
  if receipt_exists; then rm -f -- "$RECEIPT"; removed=1; fi
  if (( have_state )); then rmdir "$STATE_DIR" 2>/dev/null || true; fi
  if (( removed )); then printf 'Removed agentbrowse installation\n'; else printf 'Agentbrowse is not installed\n'; fi
}

if (( $# > 1 )); then die "expected at most one installer option" 2; fi
case "${1:---install}" in
  --install) install_agentbrowse ;;
  --uninstall) uninstall_agentbrowse ;;
  --help|-h) usage ;;
  *) printf 'Unknown installer option: %s\n' "$1" >&2; usage >&2; exit 2 ;;
esac
