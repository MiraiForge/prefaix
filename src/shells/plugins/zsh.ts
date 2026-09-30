export const ZSH_PLUGIN = `# Prefaix uses a widget so the shell never parses an AI prompt.
[[ -o interactive ]] || return
zmodload zsh/datetime
if [[ -z \${PREFAIX_SHELL_ID-} ]]; then
  typeset -g PREFAIX_SHELL_ID="$$-\${EPOCHSECONDS}-\${RANDOM}\${RANDOM}"
  typeset -g PREFAIX_CONVERSATION_ID='' PREFAIX_PREVIOUS_CONVERSATION_ID='' PREFAIX_STATUS=''
fi
typeset +x PREFAIX_SHELL_ID PREFAIX_CONVERSATION_ID PREFAIX_PREVIOUS_CONVERSATION_ID PREFAIX_STATUS
export PREFAIX_PLUGIN_LOADED=1 PREFAIX_SHELL=zsh PREFAIX_SHELL_VERSION=$ZSH_VERSION
typeset -ga __prefaix_recent
: \${__prefaix_sequence:=0}

prefaix_prompt_info() {
  local file="$__prefaix_runtime/shells/$PREFAIX_SHELL_ID/status" value
  if [[ -f $file ]]; then IFS= read -r value < "$file"; PREFAIX_STATUS=$value; fi
  print -rn -- "$PREFAIX_STATUS"
}

__prefaix_preexec() { __prefaix_command=$1; }
__prefaix_precmd() {
  local code=$?
  if [[ -n \${__prefaix_command-} ]]; then
    __prefaix_recent+=("$code:$__prefaix_command")
    (( \${#__prefaix_recent} > __prefaix_limit )) && __prefaix_recent=("\${(@)__prefaix_recent[-__prefaix_limit,-1]}")
    (( __prefaix_limit == 0 )) && __prefaix_recent=()
    __prefaix_command=''
  fi
  prefaix_prompt_info >/dev/null
  __prefaix_prompt_status=\${PREFAIX_STATUS//\\%/%%}
  return $code
}

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
  BUFFER=$buffer
  CURSOR=\${#BUFFER}
  if [[ $cursor == <-> && \${#cursor} -le 8 ]] && (( 10#$cursor <= \${#BUFFER} )); then CURSOR=$((10#$cursor)); fi
}

__prefaix_osc() {
  [[ $__prefaix_osc_mode == off ]] && return
  if [[ $__prefaix_osc_mode == on || -n \${TERM_PROGRAM-}\${GHOSTTY_RESOURCES_DIR-}\${KITTY_WINDOW_ID-}\${WEZTERM_PANE-} ]]; then
    printf '\\e]133;%s\\a' "$1"
  fi
}

__prefaix_accept_line() {
  local line=$BUFFER first=\${BUFFER%%$'\\n'*}
  if [[ $CONTEXT != start || $line != :* ]]; then zle accept-line; return; fi
  if [[ $__prefaix_classify == 0 && $first =~ $__prefaix_passthrough ]]; then zle accept-line; return; fi
  if [[ $__prefaix_classify == 1 || $first =~ $__prefaix_classify_hint ]]; then
    zle -I
    command prefaix classify -- "$line" </dev/null
    local classification=$?
    if (( classification == 1 )); then zle accept-line; return; fi
    if (( classification != 0 )); then zle reset-prompt; return; fi
  fi
  local __prefaix_nonce="$PREFAIX_SHELL_ID-$((++__prefaix_sequence))-$RANDOM$RANDOM"
  local __prefaix_file="$__prefaix_runtime/shells/$PREFAIX_SHELL_ID/directives"
  local -a recent_args
  local entry
  for entry in "\${__prefaix_recent[@]}"; do recent_args+=(--recent "$entry"); done
  print -s -- "$line"
  BUFFER=''
  zle -I
  __prefaix_osc B; __prefaix_osc C
  command prefaix run --shell zsh --shell-version "$ZSH_VERSION" --shell-pid "$$" --shell-id "$PREFAIX_SHELL_ID" --conversation "$PREFAIX_CONVERSATION_ID" --previous-conversation "$PREFAIX_PREVIOUS_CONVERSATION_ID" --nonce "$__prefaix_nonce" --directives "$__prefaix_file" --cwd "$PWD" "\${recent_args[@]}" -- "$line" </dev/tty >/dev/tty 2>/dev/tty
  local code=$?
  __prefaix_osc "D;$code"
  __prefaix_directives
  if [[ -n $BUFFER ]]; then zle reset-prompt; else zle accept-line; fi
}

__prefaix_bind() {
  local map
  zle -N prefaix-accept-line __prefaix_accept_line
  for map in main emacs viins vicmd; do
    bindkey -M "$map" '^M' prefaix-accept-line
    bindkey -M "$map" '^J' prefaix-accept-line
  done
}
__prefaix_bind
typeset -ga precmd_functions preexec_functions zvm_after_init_commands
precmd_functions=(__prefaix_precmd \${precmd_functions:#__prefaix_precmd})
preexec_functions=(\${preexec_functions:#__prefaix_preexec} __prefaix_preexec)
zvm_after_init_commands=(\${zvm_after_init_commands:#__prefaix_bind} __prefaix_bind)
if [[ $__prefaix_rprompt == on && \${RPROMPT-} != *__prefaix_prompt_status* ]]; then
  setopt promptsubst
  RPROMPT='\${__prefaix_prompt_status}'\${RPROMPT:+" $RPROMPT"}
elif [[ $__prefaix_rprompt == auto && -n \${RPROMPT-}\${P9K_VERSION-}\${STARSHIP_SHELL-} && -z \${__prefaix_prompt_hint-} ]]; then
  print -u2 -- 'prefaix: keeping your right prompt; use prefaix_prompt_info in your theme.'
  __prefaix_prompt_hint=1
fi
if (( $+functions[forge-accept-line] || $+functions[__forge_accept_line] )); then
  export PREFAIX_FORGE_CONFLICT=1
  print -u2 -- 'prefaix: remove the Forge shell plugin; both plugins bind Enter.'
fi
if (( \${ZSH_HIGHLIGHT_HIGHLIGHTERS[(Ie)pattern]} )); then
  typeset -gA ZSH_HIGHLIGHT_PATTERNS
  ZSH_HIGHLIGHT_PATTERNS[':*']='fg=green'
fi
`;
