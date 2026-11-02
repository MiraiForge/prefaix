"""Execute the exact inline ordinary-CI verifier without network access."""
import contextlib
import io
import json
import os
from pathlib import Path
import re
import tempfile
import textwrap
import types
import unittest
import urllib.error
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
REPOSITORY = 'MiraiForge/prefaix'
PIPELINE = 'prefaix-shadow-ci'
WORKFLOW = 'ci.yml'


def load_bridge(name):
    workflow = (ROOT / '.github/workflows' / name).read_text()
    body = workflow.split("          python3 - <<'PY'\n")[1].split('          PY\n')[0]
    module = types.ModuleType('inline_janus_bridge')
    exec(compile(textwrap.dedent(body), name, 'exec'), module.__dict__)
    return workflow, module


class StatusBridgeTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.workflow, cls.bridge = load_bridge(WORKFLOW)

    def row(self, state='success'):
        return {'context': 'buildkite/' + PIPELINE + '/pr', 'state': state,
                'creator': {'id': 20291210, 'login': 'buildkite-limited-access[bot]', 'type': 'Bot'},
                'target_url': 'https://buildkite.com/mirai-forge/' + PIPELINE + '/builds/1'}

    def environment(self, **overrides):
        env = {'USE_JANUS': 'true', 'HOSTED_RESULTS': '{"hosted":{"result":"skipped"}}',
               'EXPECTED_REPOSITORY': REPOSITORY, 'JANUS_PIPELINE': PIPELINE,
               'GITHUB_REPOSITORY': REPOSITORY, 'GITHUB_EVENT_NAME': 'pull_request',
               'GITHUB_REF': 'refs/pull/1/merge', 'GITHUB_SHA': 'b' * 40, 'GH_TOKEN': 'fixture'}
        env.update(overrides)
        return env

    def event(self):
        return {'pull_request': {'head': {'repo': {'full_name': REPOSITORY}, 'sha': 'a' * 40},
                                 'base': {'ref': 'main'}}}

    def invoke(self, rows=None, event=None, **environment):
        with tempfile.NamedTemporaryFile('w') as file:
            json.dump(self.event() if event is None else event, file)
            file.flush()
            env = self.environment(GITHUB_EVENT_PATH=file.name, **environment)
            with patch.dict(os.environ, env, clear=True), \
                    patch.object(self.bridge.urllib.request, 'urlopen') as request, \
                    contextlib.redirect_stdout(io.StringIO()):
                request.return_value.__enter__.return_value = io.StringIO(json.dumps(rows if rows is not None else [self.row()]))
                self.bridge.main()
                return request

    def test_actual_inline_accepts_authenticated_head_status(self):
        request = self.invoke()
        self.assertEqual(request.call_count, 1)
        self.assertIn('/commits/' + 'a' * 40 + '/statuses?', request.call_args.args[0].full_url)

    def test_latest_pending_or_failure_does_not_reuse_success(self):
        for state in ['pending', 'failure', 'error']:
            self.assertEqual(self.bridge.selected_status([self.row(state), self.row()], self.row()['context'], PIPELINE), state)

    def test_wrong_identity_rejected(self):
        for key, value in [('id', 1), ('login', 'other[bot]'), ('type', 'User')]:
            row = self.row()
            row['creator'][key] = value
            with self.assertRaises(ValueError): self.invoke([row])

    def test_wrong_build_target_rejected(self):
        for target in ['https://example.test/1', self.row()['target_url'] + '#job', self.row()['target_url'] + '/extra', self.row()['target_url'].replace(PIPELINE, 'other')]:
            row = self.row()
            row['target_url'] = target
            with self.assertRaises(ValueError): self.invoke([row])

    def test_unknown_status_rejected(self):
        with self.assertRaises(ValueError): self.invoke([self.row('neutral')])

    def test_failed_native_status_rejected(self):
        for state in ['failure', 'error']:
            with self.assertRaises(SystemExit): self.invoke([self.row(state)])

    def test_hosted_fallback_requires_success_without_api(self):
        request = self.invoke(USE_JANUS='false', HOSTED_RESULTS='{"hosted":{"result":"success"}}')
        request.assert_not_called()
        for state in ['skipped', 'failure', 'cancelled']:
            with self.assertRaises(SystemExit): self.invoke(USE_JANUS='false', HOSTED_RESULTS=json.dumps({'hosted': {'result': state}}))

    def test_cancelled_or_failed_hosted_result_cannot_be_ignored(self):
        for state in ['failure', 'cancelled']:
            with self.assertRaises(SystemExit): self.invoke(HOSTED_RESULTS=json.dumps({'hosted': {'result': state}}))

    def test_empty_needs_cannot_pass(self):
        with self.assertRaises(SystemExit): self.invoke(HOSTED_RESULTS='{}')

    def test_forks_cannot_force_janus(self):
        event = self.event()
        event['pull_request']['head']['repo']['full_name'] = 'fork/repo'
        with self.assertRaises(SystemExit): self.invoke(event=event)

    def test_non_main_pr_keeps_hosted_fallback(self):
        event = self.event()
        event['pull_request']['base']['ref'] = 'release'
        with self.assertRaises(SystemExit): self.invoke(event=event)

    def test_wrong_repository_rejected(self):
        with self.assertRaises(SystemExit): self.invoke(GITHUB_REPOSITORY='other/repo')

    def test_manual_cannot_force_janus(self):
        with self.assertRaises(SystemExit): self.invoke(GITHUB_EVENT_NAME='workflow_dispatch')

    def test_push_uses_immutable_sha_and_push_context(self):
        row = self.row()
        row['context'] = 'buildkite/' + PIPELINE
        request = self.invoke([row], GITHUB_EVENT_NAME='push', GITHUB_REF='refs/heads/main')
        self.assertIn('/commits/' + 'b' * 40 + '/statuses?', request.call_args.args[0].full_url)
        with self.assertRaises(SystemExit): self.invoke([row], GITHUB_EVENT_NAME='push', GITHUB_REF='refs/heads/main', GITHUB_SHA='main')

    def test_non_main_branch_route_and_tag_denial(self):
        row = self.row()
        row['context'] = 'buildkite/' + PIPELINE
        with self.assertRaises(SystemExit):
            self.invoke([row], GITHUB_EVENT_NAME='push', GITHUB_REF='refs/heads/feature/ci')
        for ref in ['refs/tags/v1.0.0', 'refs/pull/1/merge', 'refs/heads/']:
            with self.assertRaises(SystemExit): self.invoke([row], GITHUB_EVENT_NAME='push', GITHUB_REF=ref)

    def test_deadline_and_read_budget_are_finite(self):
        with patch.object(self.bridge.time, 'monotonic', side_effect=[0, 1801]), patch.object(self.bridge.time, 'sleep') as sleep:
            with self.assertRaisesRegex(SystemExit, '30 minutes'): self.invoke([])
            sleep.assert_not_called()

    def invoke_sequence(self, failures, remaining=1799, expected_error=None):
        with tempfile.NamedTemporaryFile('w') as file:
            json.dump(self.event(), file)
            file.flush()
            with patch.dict(os.environ, self.environment(GITHUB_EVENT_PATH=file.name), clear=True), \
                    patch.object(self.bridge.urllib.request, 'urlopen') as request, \
                    patch.object(self.bridge.time, 'monotonic', side_effect=[0] + [1800 - remaining] * 500), \
                    patch.object(self.bridge.time, 'sleep') as sleep, \
                    contextlib.redirect_stdout(io.StringIO()):
                request.side_effect = failures + [io.StringIO(json.dumps([self.row()]))]
                if expected_error:
                    with self.assertRaisesRegex(SystemExit, expected_error):
                        self.bridge.main()
                else:
                    self.bridge.main()
                return request, sleep

    def test_transient_transport_and_http_errors_retry_within_budget(self):
        for error in [urllib.error.URLError('temporary'), TimeoutError(),
                      urllib.error.HTTPError('fixture', 503, 'temporary', {}, None),
                      urllib.error.HTTPError('fixture', 429, 'limited', {}, None),
                      urllib.error.HTTPError('fixture', 403, 'limited', {}, io.BytesIO(b'Secondary rate limit'))]:
            request, sleep = self.invoke_sequence([error])
            self.assertEqual(request.call_count, 2)
            sleep.assert_called_once_with(15)

    def test_http_error_body_transport_failure_retries_and_closes(self):
        for failure in [TimeoutError(), self.bridge.http.client.IncompleteRead(b'')]:
            body = io.BytesIO(b'Forbidden')
            error = urllib.error.HTTPError('fixture', 403, 'denied', {}, body)
            with patch.object(error, 'read', side_effect=failure):
                request, sleep = self.invoke_sequence([error])
            self.assertTrue(body.closed)
            self.assertEqual(request.call_count, 2)
            sleep.assert_called_once_with(15)

    def test_permission_errors_fail_immediately(self):
        for code in [401, 403, 404]:
            error = urllib.error.HTTPError('fixture', code, 'denied', {}, io.BytesIO(b'Forbidden'))
            with self.assertRaises(urllib.error.HTTPError):
                self.invoke_sequence([error])

    def test_retry_after_is_bounded_by_existing_deadline(self):
        error = urllib.error.HTTPError('fixture', 403, 'limited', {'Retry-After': '9999'}, None)
        _, sleep = self.invoke_sequence([error], remaining=7)
        sleep.assert_called_once_with(7)

    def test_repeated_transient_errors_cannot_exceed_read_budget(self):
        failures = [urllib.error.URLError('temporary') for _ in range(122)]
        request, _ = self.invoke_sequence(failures, expected_error='30 minutes')
        self.assertEqual(request.call_count, 121)

    def test_success_on_second_page_is_verified_with_shared_budget(self):
        unrelated = [{'context': 'unrelated'} for _ in range(100)]
        request, sleep = self.invoke_sequence([io.StringIO(json.dumps(unrelated))])
        self.assertEqual(request.call_count, 2)
        self.assertTrue(request.call_args_list[0].args[0].full_url.endswith('page=1'))
        self.assertTrue(request.call_args_list[1].args[0].full_url.endswith('page=2'))
        sleep.assert_not_called()

    def test_primary_rate_limit_wait_is_bounded(self):
        error = urllib.error.HTTPError('fixture', 403, 'limited',
                  {'X-RateLimit-Remaining': '0', 'X-RateLimit-Reset': '9999999999'}, None)
        _, sleep = self.invoke_sequence([error], remaining=8)
        sleep.assert_called_once_with(8)

    def test_body_read_and_json_errors_retry(self):
        for error in [self.bridge.http.client.RemoteDisconnected(),
                      self.bridge.http.client.IncompleteRead(b''), ConnectionResetError(),
                      json.JSONDecodeError('truncated', '', 0)]:
            request, _ = self.invoke_sequence([error])
            self.assertEqual(request.call_count, 2)

    def test_required_hosted_job_is_not_allowed_to_skip(self):
        with self.assertRaisesRegex(SystemExit, 'hosted job'):
            self.invoke(REQUIRED_HOSTED_JOBS='["hosted"]')

    def test_gate_has_read_only_status_permissions_and_cancellation(self):
        self.assertIn('statuses: read', self.workflow)
        self.assertIn('if: cancelled()\n        run: exit 1', self.workflow)
        self.assertIn('HOSTED_RESULTS: ${{ toJSON(needs) }}', self.workflow)
        self.assertIn('timeout-minutes: 35', self.workflow)



if __name__ == '__main__':
    unittest.main()
