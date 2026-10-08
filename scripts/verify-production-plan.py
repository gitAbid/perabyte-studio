#!/usr/bin/env python3
"""Validate planning artifacts, not implemented product or media quality."""
import json
import re
from pathlib import Path
ROOT = Path(__file__).resolve().parents[1]
KIT = ROOT / 'docs/production'

def validate(registry, pilots):
    errors = []
    def check(ok, message):
        if not ok:
            errors.append(message)
    check(registry.get('schema_version') == 1, 'registry schema_version must be 1')
    check(bool(re.fullmatch(r'[0-9a-f]{40}', registry.get('base_sha', ''))), 'invalid base SHA')
    tasks = registry.get('tasks', [])
    by_id = {t['id']: t for t in tasks}
    check(len(by_id) == len(tasks), 'duplicate task ID')
    check(set(by_id) == {f'C{i:02}' for i in range(18)} | {'I00', 'I01', 'I02'}, 'expected C00–C17 plus runtime I00, budget I01 and proposal I02')
    owners = {}
    for task in tasks:
        tid = task['id']
        check(task.get('status') in ['planned', 'active', 'review', 'done', 'blocked'], f'{tid}: invalid status')
        check(isinstance(task.get('wave'), int), f'{tid}: wave must be integer')
        for dep in task.get('depends_on', []):
            check(dep in by_id, f'{tid}: unknown dependency {dep}')
            if dep in by_id:
                check(by_id[dep]['wave'] < task['wave'], f'{tid}: dependency {dep} must be in earlier wave')
        check(bool(task.get('acceptance_ids')), f'{tid}: missing acceptance IDs')
        check(all(re.fullmatch(r'G\d{2}', g) for g in task.get('gate_ids', [])), f'{tid}: malformed gates')
        check(bool(task.get('commands')), f'{tid}: no verification commands')
        for command in task.get('commands', []):
            check(isinstance(command, list) and bool(command) and all(isinstance(x, str) and x for x in command), f'{tid}: commands must be argv arrays')
        for path in task.get('owned_files', []):
            check(not path.startswith('/') and '..' not in Path(path).parts and not re.search(r'[\*?]', path) and all('[' not in part and ']' not in part or bool(re.fullmatch(r'\[\w+\]', part)) for part in Path(path).parts), f'{tid}: ownership path must be exact and relative: {path}')
            key = (task.get('wave'), path)
            check(key not in owners, f'{tid}: same-wave overlap with {owners.get(key)}: {path}')
            owners[key] = tid
        if task.get('release_required'):
            check(bool(task.get('owned_files')), f'{tid}: release packet must own files')
        check(not task.get('allow_paid_calls') or tid in ['C13', 'C14', 'C16'], f'{tid}: unexpected paid call permission')
    profiles = pilots.get('profiles', [])
    check(len(profiles) == 2, 'expected short and long pilots')
    for profile in profiles:
        pid = profile['id']
        beats = {b['id'] for b in profile['beats']}
        shots = profile['shots']
        coverage = {b for s in shots for b in s['beat_ids']}
        check(coverage == beats, f'{pid}: missing or unknown beat coverage')
        check(sum(s['frames'] for s in shots) == profile['expected_frames'], f'{pid}: wrong frame total')
        check(profile['fps'] == 24 and profile['sample_rate'] == 48000, f'{pid}: wrong timeline grid')
        check(len({s['id'] for s in shots}) == len(shots), f'{pid}: duplicate shot')
        check(profile['media_status'] == 'not_generated', f'{pid}: planning fixtures must not imply rendered media')
    return errors

def main():
    registry = json.loads((KIT / 'task-registry.json').read_text())
    pilots = json.loads((KIT / 'fixtures/pilots.json').read_text())
    errors = validate(registry, pilots)
    packets = (KIT / 'TASK_PACKETS.md').read_text()
    gates = (KIT / 'QUALITY_GATES.md').read_text()
    for task in registry['tasks']:
        if f"### {task['id']} —" not in packets:
            errors.append(f"{task['id']}: missing packet heading")
        for gate in task['gate_ids']:
            if f'| {gate} |' not in gates:
                errors.append(f"{task['id']}: unknown gate {gate}")
    # Verify the checker rejects dependency and ownership mistakes.
    import copy
    bad = copy.deepcopy(registry)
    bad['tasks'][0]['depends_on'] = ['C17']
    assert validate(bad, pilots), 'negative dependency control failed'
    bad = copy.deepcopy(registry)
    parallel = [t for t in bad['tasks'] if t['wave'] == 1]
    assert len(parallel) >= 2
    parallel[1]['owned_files'].append(parallel[0]['owned_files'][0])
    assert validate(bad, pilots), 'negative ownership control failed'
    print(json.dumps({'scope':'planning artifacts only','passed':not errors,'tasks':len(registry['tasks']),'pilot_shots':[len(p['shots']) for p in pilots['profiles']],'errors':errors}, indent=2))
    raise SystemExit(1 if errors else 0)

if __name__ == '__main__':
    main()
