"""Portable runner that never replaces the committed evidence packet."""
import argparse
import concurrent.futures
import datetime
import hashlib
import json
import os
import pathlib
import shutil
import subprocess

HERE = pathlib.Path(__file__).resolve().parent


def resolve_cli(name, override):
    candidate = os.environ.get(override) or shutil.which(name)
    if not candidate:
        raise RuntimeError(f'Install {name} on PATH or set {override} to its executable.')
    path = pathlib.Path(candidate).expanduser().resolve(strict=True)
    if name == 'claude' and path.suffix.lower() in ('.cmd', '.ps1'):
        # npm's Windows launchers live beside the native package executable.
        native = path.parent / 'node_modules/@anthropic-ai/claude-code/bin/claude.exe'
        if native.is_file():
            path = native.resolve(strict=True)
        else:
            raise RuntimeError(f'Set {override} to the native Claude executable, not a shell launcher.')
    if not path.is_file():
        raise RuntimeError(f'{override} must identify an executable file.')
    return str(path)


def main(prompt_file, suffix, timeout):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output-dir', required=True, type=pathlib.Path,
                        help='New directory for rerun evidence. Must not already exist.')
    options = parser.parse_args()
    claude = resolve_cli('claude', 'SCHOLAR_REVIEW_CLAUDE')
    agy = resolve_cli('agy', 'SCHOLAR_REVIEW_AGY')
    prompt_bytes = (HERE / prompt_file).read_bytes()
    prompt = prompt_bytes.decode('utf-8')
    digest = hashlib.sha256(prompt_bytes).hexdigest()
    output = options.output_dir.expanduser().resolve()
    output.mkdir(parents=True, exist_ok=False)
    (output / prompt_file).write_bytes(prompt_bytes)

    def run(provider, model, args, stdin):
        start = datetime.datetime.now(datetime.timezone.utc).isoformat()
        result = subprocess.run(args, input=stdin, text=True, encoding='utf-8',
                                capture_output=True, cwd=output, timeout=timeout)
        raw_file = output / (provider + suffix + '-raw.json')
        raw_file.write_text(result.stdout, encoding='utf-8')
        (output / (provider + suffix + '-stderr.txt')).write_text(result.stderr, encoding='utf-8')
        try:
            raw = json.loads(result.stdout)
        except json.JSONDecodeError:
            raw = {}
        record = dict(provider=provider, requested_model=model,
                      response_reported_model=list(raw.get('modelUsage', {})) or None,
                      invocation_utc=start, prompt_file=prompt_file,
                      prompt_sha256=digest, returncode=result.returncode,
                      raw_reply_sha256=hashlib.sha256(raw_file.read_bytes()).hexdigest(),
                      independent_proposal=True,
                      tools_policy='No tools, strict MCP config, no session persistence'
                      if provider == 'opus' else 'Explicit no-tools prompt instruction only')
        (output / (provider + suffix + '-provenance.json')).write_text(
            json.dumps(record, indent=2) + '\n', encoding='utf-8')
        print(provider, result.returncode, len(result.stdout), flush=True)
        if result.returncode:
            raise RuntimeError(f'{provider} failed. Inspect the retained rerun output.')

    with concurrent.futures.ThreadPoolExecutor() as pool:
        futures = [
            pool.submit(run, 'opus', 'opus', [claude, '-p', '--model', 'opus',
                        '--tools', '', '--strict-mcp-config', '--no-session-persistence',
                        '--disable-slash-commands', '--output-format', 'json'], prompt),
            pool.submit(run, 'gemini', 'gemini-3.8-flash-high', [agy, '--model',
                        'gemini-3.8-flash-high', '--mode', 'plan', '--disable-slash-commands',
                        '--output-format', 'json', '-p', prompt], None),
        ]
        for future in futures:
            future.result()
