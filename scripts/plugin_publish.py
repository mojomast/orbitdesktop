#!/usr/bin/env python3
"""Publish a content-addressed static plugin bundle."""

import argparse
import hashlib
import json
import math
import os
import re
import shutil
import stat
import subprocess
import tempfile
from pathlib import Path

# Author-declared finite config metadata mirrored from src/plugin-config-schema.ts.
# Keep every bound in sync; tests/plugin-config-schema.test.py and the JS suite
# both read tests/fixtures/plugin-config-schema.json so the two stay aligned.
MAX_SCHEMA_FIELDS = 32
MAX_SCHEMA_SERIALIZED = 8192
MAX_SCHEMA_ENUM = 32
MAX_SCHEMA_TITLE = 60
MAX_SCHEMA_DESCRIPTION = 200
MAX_SCHEMA_STRING = 4096
CONFIG_KEY_PATTERN = re.compile(r'[a-zA-Z][a-zA-Z0-9_-]{0,47}\Z')
SCHEMA_FIELD_PROPERTIES = {'key', 'type', 'title', 'description', 'default', 'enum', 'min', 'max', 'required'}
SCHEMA_FIELD_TYPES = ('string', 'number', 'boolean')


def _schema_error(message):
    raise ValueError('Invalid config schema: ' + message)


def _is_primitive(value):
    return type(value) in (str, int, float, bool)


def _primitive_type(value):
    if type(value) is bool:
        return 'boolean'
    if type(value) in (int, float):
        return 'number'
    if type(value) is str:
        return 'string'
    return None


def _has_control_chars(value):
    return any(ord(character) < 32 for character in value)


def _checksum(value):
    return json.dumps(value, sort_keys=True, separators=(',', ':'))


def _validate_string_value(value, label):
    if len(value) > MAX_SCHEMA_STRING:
        _schema_error(f'{label} must be at most {MAX_SCHEMA_STRING} characters')
    if _has_control_chars(value):
        _schema_error(f'{label} must not contain control characters')


def _validate_schema_field(value, index, seen):
    if not isinstance(value, dict):
        _schema_error(f'field {index + 1} must be an object')
    extra = set(value) - SCHEMA_FIELD_PROPERTIES
    if extra:
        _schema_error(f'field {index + 1} has unsupported property "{sorted(extra)[0]}"')

    key = value.get('key')
    if type(key) is not str or not CONFIG_KEY_PATTERN.match(key):
        _schema_error(f'field {index + 1} key must match {CONFIG_KEY_PATTERN.pattern}')
    if key in seen:
        _schema_error(f'duplicate field key "{key}"')
    seen.add(key)

    field_type = value.get('type')
    if field_type not in SCHEMA_FIELD_TYPES:
        _schema_error(f'field "{key}" type must be string, number or boolean')

    field = {'key': key, 'type': field_type}

    title = value.get('title')
    if title is not None:
        if type(title) is not str or not 1 <= len(title) <= MAX_SCHEMA_TITLE or _has_control_chars(title):
            _schema_error(f'field "{key}" title must be 1–{MAX_SCHEMA_TITLE} printable characters')
        field['title'] = title

    description = value.get('description')
    if description is not None:
        if type(description) is not str or len(description) > MAX_SCHEMA_DESCRIPTION or _has_control_chars(description):
            _schema_error(f'field "{key}" description must be at most {MAX_SCHEMA_DESCRIPTION} printable characters')
        field['description'] = description

    choices = value.get('enum')
    if choices is not None:
        if field_type == 'boolean':
            _schema_error(f'field "{key}" boolean fields cannot declare an enum')
        if not isinstance(choices, list) or not 1 <= len(choices) <= MAX_SCHEMA_ENUM:
            _schema_error(f'field "{key}" enum must have 1–{MAX_SCHEMA_ENUM} choices')
        normalized = []
        for choice in choices:
            if not _is_primitive(choice):
                _schema_error(f'field "{key}" enum choices must be string, number or boolean')
            if _primitive_type(choice) != field_type:
                _schema_error(f'field "{key}" enum choices must match the {field_type} type')
            if _primitive_type(choice) == 'number' and not math.isfinite(choice):
                _schema_error(f'field "{key}" enum numbers must be finite')
            if type(choice) is str:
                _validate_string_value(choice, f'field "{key}" enum choice')
            if any(_checksum(existing) == _checksum(choice) for existing in normalized):
                _schema_error(f'field "{key}" enum choices must be unique')
            normalized.append(choice)
        field['enum'] = normalized

    minimum, maximum = value.get('min'), value.get('max')
    if minimum is not None or maximum is not None:
        if field_type != 'number':
            _schema_error(f'field "{key}" min/max are only valid for number fields')
        if minimum is not None and (type(minimum) not in (int, float) or not math.isfinite(minimum)):
            _schema_error(f'field "{key}" min must be a finite number')
        if maximum is not None and (type(maximum) not in (int, float) or not math.isfinite(maximum)):
            _schema_error(f'field "{key}" max must be a finite number')
        if minimum is not None and maximum is not None and minimum > maximum:
            _schema_error(f'field "{key}" min must not exceed max')
        if minimum is not None:
            field['min'] = minimum
        if maximum is not None:
            field['max'] = maximum

    required = value.get('required')
    if required is not None:
        if type(required) is not bool:
            _schema_error(f'field "{key}" required must be a boolean')
        field['required'] = required

    if 'default' in value:
        subject = value['default']
        if not _is_primitive(subject):
            _schema_error(f'field "{key}" default must be string, number or boolean')
        if _primitive_type(subject) != field_type:
            _schema_error(f'field "{key}" default must match the {field_type} type')
        if _primitive_type(subject) == 'number' and not math.isfinite(subject):
            _schema_error(f'field "{key}" default must be finite')
        if type(subject) is str:
            _validate_string_value(subject, f'field "{key}" default')
        if field.get('enum') and not any(_checksum(choice) == _checksum(subject) for choice in field['enum']):
            _schema_error(f'field "{key}" default must be one of the declared enum choices')
        if _primitive_type(subject) == 'number':
            if 'min' in field and subject < field['min']:
                _schema_error(f'field "{key}" default must be at least {field["min"]}')
            if 'max' in field and subject > field['max']:
                _schema_error(f'field "{key}" default must be at most {field["max"]}')
        # A required field's effective default must itself satisfy "required", or the
        # helper would accept the metadata yet reject the same value once present.
        if field.get('required') and field_type == 'string' and subject == '':
            _schema_error(f'field "{key}" required string default must not be empty')
        field['default'] = subject

    return field


def validate_config_schema(value):
    """Validate and normalize an author-declared config schema. Raises ValueError."""
    if not isinstance(value, dict):
        _schema_error('must be an object')
    extra = set(value) - {'fields'}
    if extra:
        _schema_error(f'unsupported property "{sorted(extra)[0]}"')
    fields = value.get('fields')
    if not isinstance(fields, list):
        _schema_error('fields must be an array')
    if len(fields) > MAX_SCHEMA_FIELDS:
        _schema_error(f'supports at most {MAX_SCHEMA_FIELDS} fields')
    if len(json.dumps(value)) > MAX_SCHEMA_SERIALIZED:
        _schema_error(f'serialized schema must be at most {MAX_SCHEMA_SERIALIZED} characters')
    seen = set()
    return {'fields': [_validate_schema_field(field, index, seen) for index, field in enumerate(fields)]}


def load_config_schema(path, parser):
    """Read and validate an optional author schema file before any publication."""
    if path is None:
        return None
    if path.is_symlink() or not path.is_file():
        parser.error('Config schema must be a regular non-symlink file')
    data = path.read_bytes()
    if len(data) > 16_000:
        parser.error('Config schema file is too large')
    try:
        value = json.loads(data.decode('utf8'), object_pairs_hook=lambda pairs: _unique_object(pairs, parser))
    except (UnicodeDecodeError, json.JSONDecodeError):
        parser.error('Config schema is not valid JSON')
    try:
        return validate_config_schema(value)
    except ValueError as error:
        parser.error(str(error))


def _unique_object(pairs, parser):
    result = {}
    for key, value in pairs:
        if key in result:
            parser.error('Config schema contains a duplicate JSON key: ' + key)
        result[key] = value
    return result


def validate_config_against_schema(config, schema):
    """Mirror of src/plugin-config-schema.ts validateConfigAgainstSchema for parity tests.

    Returns per-key messages for declared fields only; unknown keys stay allowed.
    """
    errors = {}
    if not schema:
        return errors
    for field in schema.get('fields', []):
        key = field['key']
        if not isinstance(config, dict) or key not in config:
            if field.get('required') and 'default' not in field:
                errors[key] = 'Required.'
            continue
        value = config[key]
        if _primitive_type(value) != field['type']:
            errors[key] = f"Enter a {field['type']} value."
            continue
        if field['type'] == 'number':
            if not math.isfinite(value):
                errors[key] = 'Enter a finite number.'
                continue
            if 'min' in field and value < field['min']:
                errors[key] = f"Use a value of at least {field['min']}."
                continue
            if 'max' in field and value > field['max']:
                errors[key] = f"Use a value of at most {field['max']}."
                continue
        if field.get('enum') and not any(_checksum(choice) == _checksum(value) for choice in field['enum']):
            errors[key] = 'Choose one of: ' + ', '.join(_checksum(choice) for choice in field['enum']) + '.'
            continue
        if field.get('required') and field['type'] == 'string' and value == '':
            errors[key] = 'Required.'
    return errors



def collect(root, parser):
    files = []
    directories = set()
    size = 0

    def visit(directory):
        nonlocal size
        for item in sorted(directory.iterdir()):
            relative = item.relative_to(root)
            if any(part.startswith('.') for part in relative.parts):
                parser.error('Hidden files are not allowed')
            mode = item.lstat().st_mode
            if stat.S_ISLNK(mode):
                parser.error('Symlinks are not allowed')
            if stat.S_ISDIR(mode):
                directories.add(relative)
                visit(item)
            elif stat.S_ISREG(mode):
                fd = os.open(item, os.O_RDONLY | getattr(os, 'O_NOFOLLOW', 0) | getattr(os, 'O_NONBLOCK', 0))
                with os.fdopen(fd, 'rb') as stream:
                    info = os.fstat(stream.fileno())
                    if not stat.S_ISREG(info.st_mode) or size + info.st_size > 20_000_000:
                        parser.error('Bundle limit or non-regular file')
                    content = stream.read(20_000_000 - size + 1)
                size += len(content)
                if size > 20_000_000 or len(files) >= 500:
                    parser.error('Bundle limit: 20 MB / 500 files')
                files.append((relative, content))
            else:
                parser.error('Only regular files and directories are allowed')

    mode = root.lstat().st_mode
    if not stat.S_ISDIR(mode) or stat.S_ISLNK(mode):
        parser.error('Bundle root must be a directory, not a symlink')
    visit(root)
    # Preserve the original publisher's sorted(Path) ordering across the
    # entire tree, including similarly named nested and sibling files.
    files.sort(key=lambda entry: entry[0])
    digest = hashlib.sha256()
    for relative, content in files:
        name = relative.as_posix().encode()
        digest.update(len(name).to_bytes(8, 'big') + name + len(content).to_bytes(8, 'big') + content)
    return files, directories, digest.hexdigest()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('folder', type=Path)
    parser.add_argument('--id', required=True)
    parser.add_argument('--version', required=True)
    parser.add_argument('--title', required=True)
    parser.add_argument('--config-schema', type=Path, default=None, help='Optional author config schema JSON; emitted into the manifest only, never copied into the bundle')
    parser.add_argument('--runtime', type=Path, default=Path(__file__).resolve().parents[1] / '.runtime')
    args = parser.parse_args()
    if not re.fullmatch(r'[a-z][a-z0-9-]{0,25}', args.id) or not re.fullmatch(r'\d+\.\d+\.\d+', args.version) or not 1 <= len(args.title) <= 60:
        parser.error('Invalid id/version/title')

    # Validate the optional schema before touching the runtime so an invalid
    # schema never creates a partially published bundle.
    config_schema = load_config_schema(args.config_schema, parser)

    files, directories, digest = collect(args.folder, parser)
    if not any(name == Path('index.html') for name, _ in files):
        parser.error('index.html is required')
    slug = args.id + '-' + digest[:24]
    apps = args.runtime / 'apps'
    if apps.is_symlink(): parser.error('Published apps root must not be a symlink')
    apps.mkdir(parents=True, exist_ok=True)
    dest = apps / slug

    if not os.path.lexists(dest):
        staging = Path(tempfile.mkdtemp(prefix='.plugin-stage-', dir=apps))
        try:
            for relative in directories:
                (staging / relative).mkdir(parents=True, exist_ok=True)
            for relative, content in files:
                (staging / relative).write_bytes(content)
            os.rename(staging, dest)
        finally:
            if staging.exists():
                shutil.rmtree(staging)
    else:
        existing_files, existing_directories, existing_digest = collect(dest, parser)
        if (existing_directories != directories or existing_digest != digest or
                existing_files != files):
            parser.error('Existing bundle was modified; refusing reuse')

    # The Node CLI owns SQLite writes. A standalone fresh publisher has no DB to register.
    if os.path.lexists(args.runtime / 'workspace.sqlite'):
        cli = Path(__file__).resolve().with_name('workspace_bundles.mjs')
        try:
            subprocess.run(['node', '--experimental-strip-types', str(cli), 'refresh', '--root',
                            str(args.runtime.resolve())], check=True, stdout=subprocess.PIPE, timeout=120)
        except (OSError, subprocess.CalledProcessError, subprocess.TimeoutExpired) as error:
            parser.error(f'Bundle published but workspace registration failed: {error}')

    print(json.dumps(manifest_payload(args, slug, config_schema)))


def manifest_payload(args, slug, config_schema=None):
    manifest = {'apiVersion': 1, 'id': args.id, 'version': args.version,
                'title': args.title, 'entry': '/apps/' + slug + '/index.html'}
    # Schema metadata is public and does not participate in the content address:
    # `slug`/`entry` cover only the served bundle files above. Two builds with the
    # same files but different schemas share the bundle and carry their own manifest.
    if config_schema is not None:
        manifest['configSchema'] = config_schema
    return manifest


if __name__ == '__main__':
    main()
