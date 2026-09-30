"""Pure cross-language parity for the author config schema.

Loads the same tests/fixtures/plugin-config-schema.json as
tests/plugin-config-schema.test.mjs and runs it through the publisher's mirrored
validator, so scripts/plugin_publish.py and src/plugin-config-schema.ts cannot
drift. No publication, runtime or browser is involved.
"""
import importlib.util
import json
import types
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location('plugin_publish', ROOT / 'scripts/plugin_publish.py')
plugin_publish = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(plugin_publish)
FIXTURE = json.loads((ROOT / 'tests/fixtures/plugin-config-schema.json').read_text())


class SchemaParity(unittest.TestCase):
    def test_valid_fixtures_normalize_identically(self):
        for entry in FIXTURE['valid']:
            with self.subTest(entry['name']):
                self.assertEqual(plugin_publish.validate_config_schema(entry['schema']), entry['normalized'])

    def test_invalid_fixtures_are_rejected(self):
        for entry in FIXTURE['invalid']:
            with self.subTest(entry['name']):
                with self.assertRaisesRegex(ValueError, 'Invalid config schema'):
                    plugin_publish.validate_config_schema(entry['schema'])

    def test_bounds_are_closed(self):
        fields = [{'key': f'k{index}', 'type': 'string'} for index in range(plugin_publish.MAX_SCHEMA_FIELDS + 1)]
        with self.assertRaisesRegex(ValueError, 'at most 32'):
            plugin_publish.validate_config_schema({'fields': fields})
        for extra in ({'fields': [{'key': 'a', 'type': 'string', 'regex': '.*'}]},
                      {'fields': [], 'extra': 1},
                      {'fields': [{'key': 'a', 'type': 'number', 'min': float('nan')}]}):
            with self.assertRaises(ValueError):
                plugin_publish.validate_config_schema(extra)

    def test_required_string_default_must_not_be_empty(self):
        with self.assertRaises(ValueError):
            plugin_publish.validate_config_schema({'fields': [{'key': 'a', 'type': 'string', 'required': True, 'default': ''}]})
        optional = plugin_publish.validate_config_schema({'fields': [{'key': 'a', 'type': 'string', 'default': ''}]})
        self.assertEqual(optional['fields'][0]['default'], '')
        self.assertEqual(plugin_publish.validate_config_against_schema({'a': ''}, optional), {})
        required = plugin_publish.validate_config_schema({'fields': [{'key': 'a', 'type': 'string', 'required': True}]})
        self.assertEqual(plugin_publish.validate_config_against_schema({'a': ''}, required), {'a': 'Required.'})

    def test_config_validation_matches_the_shared_fixtures(self):
        for entry in FIXTURE['configs']:
            with self.subTest(entry['name']):
                errors = plugin_publish.validate_config_against_schema(entry['config'], entry['schema'])
                self.assertEqual(sorted(errors), sorted(entry['errors']))
        self.assertEqual(plugin_publish.validate_config_against_schema({'anything': True}, None), {})

    def test_manifest_payload_carries_schema_metadata_without_changing_identity(self):
        args = types.SimpleNamespace(id='notes', version='1.0.0', title='Notes')
        base = plugin_publish.manifest_payload(args, 'notes-abc')
        self.assertEqual(base, {'apiVersion': 1, 'id': 'notes', 'version': '1.0.0', 'title': 'Notes', 'entry': '/apps/notes-abc/index.html'})
        schema = plugin_publish.validate_config_schema({'fields': [{'key': 'mode', 'type': 'string', 'enum': ['light', 'dark']}]})
        with_schema = plugin_publish.manifest_payload(args, 'notes-abc', schema)
        self.assertEqual(with_schema['entry'], base['entry'])
        self.assertEqual(with_schema['configSchema'], schema)


if __name__ == '__main__':
    unittest.main()
