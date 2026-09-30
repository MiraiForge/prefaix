export const FISH_PLUGIN = `# Prefaix receives the complete commandline before fish parses it.
status is-interactive; or return
if not set -q PREFAIX_SHELL_ID
  set -g PREFAIX_SHELL_ID "$fish_pid-"(date +%s)"-"(random)(random)
  set -g PREFAIX_CONVERSATION_ID ''
  set -g PREFAIX_PREVIOUS_CONVERSATION_ID ''
  set -g PREFAIX_STATUS ''
end
set -gu PREFAIX_SHELL_ID $PREFAIX_SHELL_ID
set -gu PREFAIX_CONVERSATION_ID "$PREFAIX_CONVERSATION_ID"
set -gu PREFAIX_PREVIOUS_CONVERSATION_ID "$PREFAIX_PREVIOUS_CONVERSATION_ID"
set -gu PREFAIX_STATUS "$PREFAIX_STATUS"
set -gx PREFAIX_PLUGIN_LOADED 1
set -gx PREFAIX_SHELL fish
set -gx PREFAIX_SHELL_VERSION $version
set -q __prefaix_sequence; or set -g __prefaix_sequence 0

function prefaix_prompt_info
  set -l file "$__prefaix_runtime/shells/$PREFAIX_SHELL_ID/status"
  if test -f "$file"
    read -l value < "$file"
    set -g PREFAIX_STATUS "$value"
  end
  printf '%s' "$PREFAIX_STATUS"
end
function __prefaix_preexec --on-event fish_preexec
  set -g __prefaix_command "$argv[1]"
end
function __prefaix_postexec --on-event fish_postexec
  set -l code $status
  if set -q __prefaix_command; and test -n "$__prefaix_command"
    set -ga __prefaix_recent "$code:$__prefaix_command"
    if test (count $__prefaix_recent) -gt $__prefaix_limit
      set -g __prefaix_recent $__prefaix_recent[-$__prefaix_limit..-1]
    end
    test $__prefaix_limit -eq 0; and set -e __prefaix_recent
    set -e __prefaix_command
  end
end
function __prefaix_directives
  test -f "$__prefaix_file"; or return
  set -l fields (string split0 < "$__prefaix_file")
  test (math (count $fields) % 2) -eq 0; or return
  set -l nonce ''
  set -l conversation "$PREFAIX_CONVERSATION_ID"
  set -l status_text "$PREFAIX_STATUS"
  set -l buffer ''
  set -l cursor ''
  set -l at 1
  while test $at -le (count $fields)
    set -l next (math $at + 1)
    switch $fields[$at]
      case nonce; set nonce "$fields[$next]"
      case conversation; set conversation "$fields[$next]"
      case status; set status_text "$fields[$next]"
      case buffer; set buffer "$fields[$next]"
      case cursor; set cursor "$fields[$next]"
    end
    set at (math $at + 2)
  end
  test "$nonce" = "$__prefaix_nonce"; or return
  if test -n "$PREFAIX_CONVERSATION_ID"; and test "$conversation" != "$PREFAIX_CONVERSATION_ID"
    set -g PREFAIX_PREVIOUS_CONVERSATION_ID "$PREFAIX_CONVERSATION_ID"
  end
  set -g PREFAIX_CONVERSATION_ID "$conversation"
  set -g PREFAIX_STATUS "$status_text"
  commandline --replace -- "$buffer"
  commandline --cursor (string length -- "$buffer")
  if string match -rq '^[0-9]{1,8}$' -- "$cursor"; and test "$cursor" -le (string length -- "$buffer")
    commandline --cursor "$cursor"
  end
end
function __prefaix_history --argument-names line
  set -q fish_private_mode; and return
  # fish 3.6 and 4.x lack history append. Import one YAML entry and merge it.
  # fish's history encoding escapes only backslash and newline.
  set -l escaped (string replace -a '\\\\' '\\\\\\\\' -- "$line" | string collect --no-trim-newlines)
  printf '%s' "$escaped" | read --null --nchars (math (string length -- "$escaped") - 1) escaped
  set escaped (string replace -a \\n '\\n' -- "$escaped" | string collect)
  set -l data_home "$HOME/.local/share"
  set -q XDG_DATA_HOME; and set data_home "$XDG_DATA_HOME"
  set -l history_name fish
  set -q fish_history; and set history_name "$fish_history"
  test -n "$history_name"; or return
  command mkdir -p -- "$data_home/fish"
  builtin history save
  set -g __prefaix_history_epoch (date +%s)
  set -l when $__prefaix_history_epoch
  if string match -q '3.*' -- "$version"
    set when (math $when + 1)
  end
  printf '- cmd: %s\\n  when: %s\\n' "$escaped" "$when" >> "$data_home/fish/$history_name"_history
end
function __prefaix_finish_history
  set -q __prefaix_history_epoch; or return
  # fish 3.6 ignores same-second merges; 4.x uses subsecond timestamps.
  # Wait only after the client has finished so first-token latency is unchanged.
  if string match -q '3.*' -- "$version"
    for attempt in 1 2 3 4 5 6 7 8 9 10 11
      test (date +%s) -gt $__prefaix_history_epoch; and break
      command sleep 0.1
    end
  end
  builtin history merge
  set -e __prefaix_history_epoch
end
function __prefaix_accept_line
  set -l line (commandline | string collect --no-trim-newlines)
  # commandline adds one newline; read removes exactly that byte, preserving
  # any trailing newlines the user actually pasted into the buffer.
  printf '%s' "$line" | read --null --nchars (math (string length -- "$line") - 1) line
  set -l first (string split -m1 \\n -- "$line")[1]
  if not string match -q ':*' -- "$line"
    commandline -f execute
    return
  end
  if test "$__prefaix_classify" = 0; and string match -rq -- "$__prefaix_passthrough" "$first"
    commandline -f execute
    return
  end
  if test "$__prefaix_classify" = 1; or string match -rq -- "$__prefaix_classify_hint" "$first"
    command prefaix classify -- "$line" </dev/null
    set -l classification $status
    if test $classification -eq 1
      commandline -f execute
      return
    else if test $classification -ne 0
      commandline -f repaint
      return
    end
  end
  set -g __prefaix_sequence (math $__prefaix_sequence + 1)
  set -g __prefaix_nonce "$PREFAIX_SHELL_ID-$__prefaix_sequence-"(random)(random)
  set -g __prefaix_file "$__prefaix_runtime/shells/$PREFAIX_SHELL_ID/directives"
  set -l recent_args
  for entry in $__prefaix_recent
    set -a recent_args --recent "$entry"
  end
  __prefaix_history "$line"
  commandline --replace ''
  printf '\\n'
  command prefaix run --shell fish --shell-version "$version" --shell-pid "$fish_pid" --shell-id "$PREFAIX_SHELL_ID" --conversation "$PREFAIX_CONVERSATION_ID" --previous-conversation "$PREFAIX_PREVIOUS_CONVERSATION_ID" --nonce "$__prefaix_nonce" --directives "$__prefaix_file" --cwd "$PWD" $recent_args -- "$line" </dev/tty >/dev/tty 2>/dev/tty
  __prefaix_finish_history
  __prefaix_directives
  set -l next_buffer (commandline | string collect)
  if test -n "$next_buffer"
    commandline -f repaint
  else
    commandline -f execute
  end
end
function __prefaix_bind --on-variable fish_key_bindings
  for mode in default insert
    bind -M $mode \\r __prefaix_accept_line
    bind -M $mode \\n __prefaix_accept_line
  end
end
__prefaix_bind
function __prefaix_abbr
  printf '%s\\n' "$argv"
end
abbr --add __prefaix_command --position command --regex ':[A-Za-z][-A-Za-z0-9_]*' --function __prefaix_abbr
function __prefaix_return_status --argument-names code
  return $code
end
function __prefaix_wrap_prompt --on-event fish_prompt
  test "$__prefaix_rprompt" != off; or return
  functions -q __prefaix_right_prompt_wrapped; and return
  if functions -q fish_right_prompt
    functions --copy fish_right_prompt __prefaix_original_right_prompt
  end
  function fish_right_prompt
    set -l previous_status $status
    prefaix_prompt_info
    if functions -q __prefaix_original_right_prompt
      test -z "$PREFAIX_STATUS"; or printf ' '
      __prefaix_return_status $previous_status
      __prefaix_original_right_prompt
    end
  end
  function __prefaix_right_prompt_wrapped; end
end
if functions -q __forge_accept_line; or functions -q _forge_accept_line
  set -gx PREFAIX_FORGE_CONFLICT 1
  printf '%s\\n' 'prefaix: remove the Forge shell plugin; both plugins bind Enter.' >&2
end
`;
