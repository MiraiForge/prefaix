export const BASH_PLUGIN = `# Prefaix intercepts the raw readline buffer before bash parses it.
[[ $- == *i* ]] || return
if [[ -z \${PREFAIX_SHELL_ID-} ]]; then
  printf -v __prefaix_epoch '%(%s)T' -1 2>/dev/null || __prefaix_epoch=$(command date +%s)
  PREFAIX_SHELL_ID="$$-\${__prefaix_epoch}-\${RANDOM}\${RANDOM}"
  PREFAIX_CONVERSATION_ID='' PREFAIX_PREVIOUS_CONVERSATION_ID='' PREFAIX_STATUS=''
fi
export -n PREFAIX_SHELL_ID PREFAIX_CONVERSATION_ID PREFAIX_PREVIOUS_CONVERSATION_ID PREFAIX_STATUS
export PREFAIX_PLUGIN_LOADED=1 PREFAIX_SHELL=bash PREFAIX_SHELL_VERSION=$BASH_VERSION
: \${__prefaix_sequence:=0}

prefaix_prompt_info() {
  local file="$__prefaix_runtime/shells/$PREFAIX_SHELL_ID/status" value
  if [[ -f $file ]]; then IFS= read -r value < "$file"; PREFAIX_STATUS=$value; fi
  printf '%s' "$PREFAIX_STATUS"
}
__prefaix_ps1() { prefaix_prompt_info; }
__prefaix_directives() {
  local key value nonce='' conversation=$PREFAIX_CONVERSATION_ID status_text=$PREFAIX_STATUS buffer='' cursor='' invalid=0
  [[ -f $__prefaix_file ]] || return
  while true; do
    key=''
    IFS= read -r -d '' key || { [[ -n $key ]] && invalid=1; break; }
    IFS= read -r -d '' value || { invalid=1; break; }
    case $key in
      nonce) nonce=$value;; conversation) conversation=$value;; status) status_text=$value;;
      buffer) buffer=$value;; cursor) cursor=$value;;
    esac
  done < "$__prefaix_file"
  [[ $invalid == 0 && $nonce == $__prefaix_nonce ]] || return
  if [[ -n $PREFAIX_CONVERSATION_ID && $conversation != $PREFAIX_CONVERSATION_ID ]]; then
    PREFAIX_PREVIOUS_CONVERSATION_ID=$PREFAIX_CONVERSATION_ID
  fi
  PREFAIX_CONVERSATION_ID=$conversation PREFAIX_STATUS=$status_text
  READLINE_LINE=$buffer
  READLINE_POINT=\${#READLINE_LINE}
  if [[ $cursor =~ ^[0-9]+$ && \${#cursor} -le 8 ]] && (( 10#$cursor <= \${#buffer} )); then READLINE_POINT=$((10#$cursor)); fi
  # Bash 4 uses byte offsets; Bash 5 changed bind -x to character offsets.
  if (( BASH_VERSINFO[0] < 5 )); then
    local prefix=\${buffer:0:READLINE_POINT}
    local LC_ALL=C
    READLINE_POINT=\${#prefix}
  fi
}
__prefaix_run() {
  local line=$1 entry
  local __prefaix_nonce="$PREFAIX_SHELL_ID-$((++__prefaix_sequence))-$RANDOM$RANDOM"
  local __prefaix_file="$__prefaix_runtime/shells/$PREFAIX_SHELL_ID/directives"
  local recent_args=()
  for entry in "\${__prefaix_recent[@]}"; do recent_args+=(--recent "$entry"); done
  command prefaix run --shell bash --shell-version "$BASH_VERSION" --shell-pid "$$" --shell-id "$PREFAIX_SHELL_ID" --conversation "$PREFAIX_CONVERSATION_ID" --previous-conversation "$PREFAIX_PREVIOUS_CONVERSATION_ID" --nonce "$__prefaix_nonce" --directives "$__prefaix_file" --cwd "$PWD" "\${recent_args[@]}" -- "$line" </dev/tty >/dev/tty 2>/dev/tty
  __prefaix_directives
}

pfx() {
  local line
  if (( $# )); then line="$*"; else IFS= read -e -r -p ': ' line || return; fi
  READLINE_LINE=''
  __prefaix_run ": $line"
  [[ -z $READLINE_LINE ]] || printf '%s\\n' "$READLINE_LINE"
}
if (( BASH_VERSINFO[0] < 4 || (BASH_VERSINFO[0] == 4 && BASH_VERSINFO[1] < 4) )); then
  if [[ -z \${__prefaix_degraded_notice-} ]]; then
    printf '%s\\n' 'prefaix: bash 4.4+ enables : interception. Run brew install bash; use pfx meanwhile.' >&2
    __prefaix_degraded_notice=1
  fi
  return
fi

declare -p __prefaix_recent >/dev/null 2>&1 || __prefaix_recent=()
__prefaix_noop() { :; }
__prefaix_step2() {
  local map
  for map in emacs-standard vi-insert vi-command; do
    if [[ $1 == edit ]]; then bind -m "$map" -x '"\\C-x\\C-_2": __prefaix_noop';
    else bind -m "$map" '"\\C-x\\C-_2": accept-line'; fi
  done
}
__prefaix_dispatch() {
  local line=$READLINE_LINE first=\${READLINE_LINE%%$'\\n'*}
  __prefaix_step2 run
  local pass=0 classification=0
  if [[ $line != :* || \${__prefaix_continuation-} == 1 ]]; then pass=1
  elif [[ $__prefaix_classify == 0 && $first =~ $__prefaix_passthrough ]]; then pass=1
  elif [[ $__prefaix_classify == 1 || $first =~ $__prefaix_classify_hint ]]; then
    command prefaix classify -- "$line" </dev/null
    classification=$?
    if (( classification == 1 )); then pass=1
    elif (( classification != 0 )); then __prefaix_step2 edit; return; fi
  fi
  if (( pass )); then
    if [[ \${__prefaix_continuation-} == 1 ]]; then
      __prefaix_pending+=$'\\n'"$line"
    else __prefaix_pending=$line; fi
    __prefaix_command=$__prefaix_pending
    return
  fi
  __prefaix_in_turn=1
  history -s -- "$line"
  READLINE_LINE=''
  printf '\\n'
  __prefaix_run "$line"
  [[ -z $READLINE_LINE ]] || __prefaix_step2 edit
  __prefaix_in_turn=''
}
__prefaix_bind() {
  local map
  for map in emacs-standard vi-insert vi-command; do
    bind -m "$map" -x '"\\C-x\\C-_1": __prefaix_dispatch'
    bind -m "$map" '"\\C-x\\C-_2": accept-line'
    bind -m "$map" '"\\C-m": "\\C-x\\C-_1\\C-x\\C-_2"'
    bind -m "$map" '"\\C-j": "\\C-x\\C-_1\\C-x\\C-_2"'
  done
}
__prefaix_preexec() { __prefaix_command=$1; }
__prefaix_debug() {
  [[ -z \${__prefaix_at_prompt-} || -n \${__prefaix_in_turn-} || $BASH_COMMAND == __prefaix_* ]] && return
  __prefaix_at_prompt=''
  __prefaix_command=\${__prefaix_pending-}
  __prefaix_pending=''
}
__prefaix_precmd() {
  local code=$?
  if [[ -n \${__prefaix_command-} ]]; then
    __prefaix_recent+=("$code:$__prefaix_command")
    (( \${#__prefaix_recent[@]} > __prefaix_limit )) && __prefaix_recent=("\${__prefaix_recent[@]: -__prefaix_limit}")
    (( __prefaix_limit == 0 )) && __prefaix_recent=()
    __prefaix_command=''
  fi
  __prefaix_at_prompt=1 __prefaix_continuation=''
  prefaix_prompt_info >/dev/null
  return "$code"
}
__prefaix_bind
# Expanding PS2 marks continuation without spawning or printing anything.
declare -a __prefaix_empty
if [[ $PS2 != *'__prefaix_continuation=1'* ]]; then
  PS2='\${__prefaix_empty[__prefaix_continuation=1]}'"$PS2"
fi
if [[ \${__prefaix_hooks_loaded-} != 1 ]]; then
  if declare -p preexec_functions >/dev/null 2>&1; then
    preexec_functions+=(__prefaix_preexec)
    precmd_functions=(__prefaix_precmd "\${precmd_functions[@]}")
  else
    if [[ -z $(trap -p DEBUG) ]]; then trap '__prefaix_debug' DEBUG; fi
    if declare -p PROMPT_COMMAND 2>/dev/null | builtin read -r _; then
      if [[ $(declare -p PROMPT_COMMAND 2>/dev/null) == 'declare -a '* ]]; then
        PROMPT_COMMAND=(__prefaix_precmd "\${PROMPT_COMMAND[@]}")
      else PROMPT_COMMAND="__prefaix_precmd\${PROMPT_COMMAND:+; $PROMPT_COMMAND}"; fi
    else PROMPT_COMMAND=__prefaix_precmd; fi
  fi
  __prefaix_hooks_loaded=1
fi
if [[ -n \${BLE_VERSION-}\${_ble_version-} ]]; then
  export PREFAIX_BLE_CONFLICT=1
  printf '%s\\n' 'prefaix: ble.sh is unsupported; disable one of the two integrations.' >&2
fi
if declare -F __forge_accept_line >/dev/null || declare -F _forge_accept_line >/dev/null; then
  export PREFAIX_FORGE_CONFLICT=1
  printf '%s\\n' 'prefaix: remove the Forge shell plugin; both plugins bind Enter.' >&2
fi
`;
