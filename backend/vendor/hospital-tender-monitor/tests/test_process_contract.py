from pathlib import Path
import shutil
import subprocess
import sys
from unittest import TestCase, skipUnless


@skipUnless(shutil.which("node"), "Node is required for the offline subprocess contract check")
class ProcessContractTests(TestCase):
    def test_node_private_resume_file_python_cli_and_normalized_snapshot_roundtrip(self):
        collector_root = Path(__file__).resolve().parents[1]
        script = """
            import assert from 'node:assert/strict';
            import { spawn } from 'node:child_process';
            import { existsSync, readFileSync, statSync } from 'node:fs';
            import { pathToFileURL } from 'node:url';
            const [root, fixture, python] = process.argv.slice(1);
            const { createInternalHospitalTenderRunner } = await import(pathToFileURL(root + '/../../src/hospitalTender/internalRunner.js'));
            const resumeFiles = [];
            const runner = createInternalHospitalTenderRunner({
                collectorRoot: root, pythonExecutable: python, timeoutMs: 10000,
                environment: { PATH: '/usr/bin:/bin' },
                spawnImpl(command, args, options) {
                    const resumePath = args.find(arg => arg.startsWith('--resume-progress=')).split('=')[1];
                    assert.equal(statSync(resumePath).mode & 0o777, 0o600);
                    assert.ok(Array.isArray(JSON.parse(readFileSync(resumePath, 'utf8'))));
                    resumeFiles.push(resumePath);
                    return spawn(command, [fixture, ...args.slice(2)], options);
                },
            });
            const first = await runner.run({ collectionProgress: [] });
            assert.equal(first.payload.sources[0].status, 'degraded');
            assert.equal(first.payload.runs[0].status, 'partial');
            assert.equal(first.payload.notices[0].sourceItemId, 'head');
            assert.equal(first.payload.collectionProgress[0].cursor.categoryIndex, 1);
            const second = await runner.run({ collectionProgress: first.payload.collectionProgress });
            assert.equal(second.payload.sources[0].status, 'healthy');
            assert.equal(second.payload.runs[0].status, 'success');
            assert.equal(second.payload.notices[0].sourceItemId, 'tail');
            assert.deepEqual(second.payload.collectionProgress[0].cursor, {});
            assert.ok(resumeFiles.every(path => !existsSync(path)));
            console.log('offline subprocess resume contract passed');
        """
        completed = subprocess.run(
            [shutil.which("node"), "--input-type=module", "-e", script, str(collector_root),
             str(collector_root / "tests" / "fixtures" / "offline_collector.py"), sys.executable],
            capture_output=True, text=True, timeout=25,
            env={"PATH": "/usr/bin:/bin", "PYTHONDONTWRITEBYTECODE": "1"},
        )
        self.assertEqual(completed.returncode, 0, completed.stderr)
        self.assertIn("offline subprocess resume contract passed", completed.stdout)
