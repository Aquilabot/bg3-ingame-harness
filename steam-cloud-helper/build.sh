#!/usr/bin/env bash
set -euo pipefail

script_directory="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
repository_root="$(cd -- "$script_directory/.." && pwd)"
output_path="${1:-$repository_root/.cache/tools/steam-cloud-helper}"
output_directory="$(dirname -- "$output_path")"

mkdir -p -- "$output_directory"
temporary_path="$(mktemp "$output_path.XXXXXX")"
trap 'rm -f -- "$temporary_path"' EXIT

"${CXX:-c++}" \
  -std=c++20 \
  -O2 \
  -Wall \
  -Wextra \
  -Werror \
  "$script_directory/main.cpp" \
  -ldl \
  -o "$temporary_path"

chmod 0755 "$temporary_path"
mv -f -- "$temporary_path" "$output_path"
trap - EXIT
