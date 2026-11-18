# ccs-i18n.sh — ccs's string tables for bash (sourced by bin/ccs and
# ccs-delete.sh; bash 3.2). The format is in ccs-i18n.ts. Needs SCRIPT_DIR.
# shellcheck shell=bash

# bash 5.2 would turn `&` in a replacement into the matched text; ccs's
# replacements are values, so that is switched off where it exists.
shopt -u patsub_replacement 2>/dev/null || true
CCS_LANGS=(ja en)
ccs_lang_load() { # ccs_lang_load FILE — its lines into CCS_T_<key>
  local line key
  [[ -r "$1" ]] || return 0
  while IFS= read -r line || [[ -n "$line" ]]; do
    line=${line%$'\r'}
    if [[ "$line" =~ ^([a-z][a-z0-9_]*)\+=(.*)$ ]]; then
      key="CCS_T_${BASH_REMATCH[1]}"
      printf -v "$key" '%s\\n%s' "${!key-}" "${BASH_REMATCH[2]}"
    elif [[ "$line" =~ ^([a-z][a-z0-9_]*)=(.*)$ ]]; then
      printf -v "CCS_T_${BASH_REMATCH[1]}" '%s' "${BASH_REMATCH[2]}"
    fi
  done < "$1"
}
tx() { # tx VAR KEY [name=value ...] — KEY's text, filled in, into VAR
  # One pass over the text, like fill() in ccs-i18n.ts: an inserted value is
  # never read again, so a `{name}` inside a value stays as written. A name
  # with no value given stays as written too. Byte-wise (LC_ALL=C): only the
  # ASCII `{` `}` and the names are matched, so any text passes through whole.
  local __out="$1" __ref="CCS_T_$2" __s __res="" __a __n __v __found
  local LC_ALL=C
  if [[ -n "${!__ref+x}" ]]; then
    __s=${!__ref}
  else
    # A key no table has: a broken install. Never show the key itself.
    __s='[ccs] ccs is not installed completely (a string table is missing); install it again'
  fi
  shift 2
  __s=${__s//\\n/$'\n'}
  while [[ -n "$__s" ]]; do
    if [[ "$__s" =~ ^([^{]*)\{([a-z][a-z0-9_]*)\}(.*)$ ]]; then
      __res+="${BASH_REMATCH[1]}"
      __n="${BASH_REMATCH[2]}" __s="${BASH_REMATCH[3]}" __found=0
      for __a in "$@"; do
        if [[ "${__a%%=*}" == "$__n" ]]; then
          __v=${__a#*=} __found=1
          break
        fi
      done
      if (( __found )); then __res+="$__v"; else __res+="{$__n}"; fi
    elif [[ "$__s" == *"{"* ]]; then
      # A `{` that opens no name: keep it and go on after it.
      __res+="${__s%%"{"*}{"
      __s=${__s#*"{"}
    else
      __res+="$__s"
      break
    fi
  done
  printf -v "$__out" '%s' "$__res"
}
say() { local __m; tx __m "$@"; printf '%s\n' "$__m"; }
say_err() { local __m; tx __m "$@"; printf '%s\n' "$__m" >&2; }
is_lang() { [[ " ${CCS_LANGS[*]} " == *" ${1:-none} "* ]]; }

# ccs_lang_use LANG — English first, then LANG over it (a key LANG's table
# lacks reads in English).
ccs_lang_use() {
  ccs_lang_load "${SCRIPT_DIR}/ccs-lang-en.txt"
  [[ "$1" == en ]] || ccs_lang_load "${SCRIPT_DIR}/ccs-lang-${1}.txt"
}
