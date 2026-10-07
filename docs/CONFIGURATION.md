# Configuration reference

Generated from `src/core/config/schema.ts` by `bun run docs:config`.
Do not edit this table by hand.

Every key is optional. Configuration lives at `$XDG_CONFIG_HOME/prefaix/config.toml`
(or `~/.config/prefaix/config.toml`). Run `prefaix config check` after editing.
Environment overrides use strings: booleans accept `true/false` or `1/0`,
lists use JSON arrays, and paths expand a leading `~`. Unknown keys are errors.

| TOML key | Type / accepted values | Default | Environment override |
|---|---|---|---|
| `agent.backend` | pi / fake | `"pi"` | `PREFAIX_AGENT_BACKEND`, `PREFAIX_BACKEND` |
| `agent.pi.bin` | string | `"pi"` | `PREFAIX_AGENT_PI_BIN` |
| `agent.pi.model` | optionalString | `null` | `PREFAIX_AGENT_PI_MODEL` |
| `agent.pi.thinking` | optionalString | `null` | `PREFAIX_AGENT_PI_THINKING` |
| `agent.pi.extensions` | user / none | `"user"` | `PREFAIX_AGENT_PI_EXTENSIONS` |
| `agent.pi.session_dir` | optionalPath | `null` | `PREFAIX_AGENT_PI_SESSION_DIR` |
| `agent.pi.extra_args` | stringList | `[]` | `PREFAIX_AGENT_PI_EXTRA_ARGS` |
| `pool.max_children` | integer (minimum 1) | `6` | `PREFAIX_POOL_MAX_CHILDREN` |
| `pool.idle_minutes` | number (minimum 0) | `15` | `PREFAIX_POOL_IDLE_MINUTES` |
| `pool.spare` | boolean | `true` | `PREFAIX_POOL_SPARE` |
| `workspace.cwd_policy` | follow / split / stay | `"split"` | `PREFAIX_WORKSPACE_CWD_POLICY` |
| `workspace.resume` | none / last-in-root | `"none"` | `PREFAIX_WORKSPACE_RESUME` |
| `ui.thinking` | hidden / summary / stream | `"hidden"` | `PREFAIX_UI_THINKING` |
| `ui.footer` | time / tools / cost / context / model | `["time","tools","cost","context","model"]` | `PREFAIX_UI_FOOTER` |
| `ui.rprompt` | auto / on / off | `"auto"` | `PREFAIX_UI_RPROMPT` |
| `ui.widgets` | ignore / info | `"ignore"` | `PREFAIX_UI_WIDGETS` |
| `ui.set_title` | boolean | `false` | `PREFAIX_UI_SET_TITLE` |
| `ui.osc133` | auto / on / off | `"auto"` | `PREFAIX_UI_OSC133` |
| `ui.picker` | auto / builtin | `"auto"` | `PREFAIX_UI_PICKER` |
| `context.recent_commands` | integer (minimum 0) | `10` | `PREFAIX_CONTEXT_RECENT_COMMANDS` |
| `context.include_exit_codes` | boolean | `true` | `PREFAIX_CONTEXT_INCLUDE_EXIT_CODES` |
| `context.redact` | boolean | `true` | `PREFAIX_CONTEXT_REDACT` |
| `context.extra_redact_patterns` | stringList | `[]` | `PREFAIX_CONTEXT_EXTRA_REDACT_PATTERNS` |
| `env.passthrough` | all / allowlist | `"all"` | `PREFAIX_ENV_PASSTHROUGH` |
| `env.allowlist` | optionalStringList | `null` | `PREFAIX_ENV_ALLOWLIST` |
| `env.deny` | stringList | `["PREFAIX_*","PWD","OLDPWD","SHLVL","_"]` | `PREFAIX_ENV_DENY` |
| `grammar.passthrough` | string | `"^:\\s*($\|[>\|<&;$({\\[])"` | `PREFAIX_GRAMMAR_PASSTHROUGH` |
| `personas.<name>.tools` | optionalStringList | `null` | `PREFAIX_PERSONAS_<NAME>_TOOLS` |
| `personas.<name>.guideline` | optionalString | `null` | `PREFAIX_PERSONAS_<NAME>_GUIDELINE` |
| `commands.suggest.model` | optionalString | `null` | `PREFAIX_COMMANDS_SUGGEST_MODEL` |
| `commands.commit.max_diff_bytes` | integer (minimum 0) | `100000` | `PREFAIX_COMMANDS_COMMIT_MAX_DIFF_BYTES` |

`personas.<name>` is an extensible table. The default `ask` and `plan` personas
allow `read`, `grep`, `find`, and `ls`; ask answers without editing, and plan
produces a plan without editing. A configured persona replaces its default entry.
An environment override can alter an existing persona but cannot introduce one.

`null` means unset. `PREFAIX_PLAIN=1` disables styling. Shell identity, live-test
settings, and `PREFAIX_FAKE_SCENARIO` are runtime controls, not TOML settings.
Some settings prepare later milestones: `commands.suggest`, `commands.commit`,
and `ui.set_title` do not enable those M4 features in the M3 build.
