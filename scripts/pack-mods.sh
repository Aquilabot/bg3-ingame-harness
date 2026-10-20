#!/usr/bin/env bash
# Packs the harness mod and the example mod into .cache/dist with LSLib.
# LSLIB_DIR must point at LSLib's Packed/Tools directory; DOTNET_BIN may name a dotnet binary.
set -euo pipefail

root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
dotnet="${DOTNET_BIN:-dotnet}"
: "${LSLIB_DIR:?Set LSLIB_DIR to the LSLib Packed/Tools directory}"
lslib_dir="$(cd -- "$LSLIB_DIR" && pwd)"
output="$root/.cache/dist"
mkdir -p -- "$output"

pack() {
  DOTNET_CLI_TELEMETRY_OPTOUT=1 "$dotnet" run --project "$root/tools/lslib-packer/LSLibPacker.csproj" \
    -p:LSLibDir="$lslib_dir" -- "$1" "$2"
}

pack "$root/mod" "$output/BG3InGameHarness.pak"
pack "$root/examples/runtime-smoke/mod" "$output/HarnessExample.pak"
