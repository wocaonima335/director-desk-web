import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import { constants } from 'node:os';

const root = fileURLToPath(new URL('../', import.meta.url));
const app = path.join(root, '.audit/desktop-app');

try {
    await Promise.all(['package.json', 'desktop/main.cjs', 'dist/index.html'].map(file => fs.access(path.join(app, file))));
} catch {
    console.error('Desktop files are missing. Run "npm run desktop:dev" to build and start the desktop app.');
    process.exit(1);
}

try {
    const executable = createRequire(import.meta.url)('electron');
    const args = process.argv.slice(2);
    if (!args.some(arg => arg === '--director-test-profile' || arg.startsWith('--director-test-profile='))) {
        const profile = path.join(root, '.local/desktop-dev-profile');
        await fs.mkdir(profile, { recursive: true });
        args.push(`--director-test-profile=${profile}`);
    }
    const env = { ...process.env };
    delete env.ELECTRON_RUN_AS_NODE;
    console.log('Starting the prepared desktop app. After source changes, run "npm run desktop:dev" to rebuild.');
    const child = spawn(executable, [app, ...args], { cwd: root, env, stdio: 'inherit' });
    const interrupt = () => child.kill('SIGINT');
    const terminate = () => child.kill('SIGTERM');
    process.on('SIGINT', interrupt);
    process.on('SIGTERM', terminate);
    const cleanup = () => {
        process.off('SIGINT', interrupt);
        process.off('SIGTERM', terminate);
    };
    child.once('error', error => {
        cleanup();
        console.error(`Could not start Electron: ${error.message}`);
        process.exitCode = 1;
    });
    child.once('exit', (code, signal) => {
        cleanup();
        process.exitCode = code ?? (signal ? 128 + (constants.signals[signal] ?? 1) : 1);
    });
} catch (error) {
    console.error(`Could not start the desktop app: ${error.message}`);
    process.exitCode = 1;
}
