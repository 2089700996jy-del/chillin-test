import { createFakeExternalsServer } from '../env/fake-externals.mjs';

/**
 * Starts an isolated in-process Fake Externals HTTP server for L2 node:test suites
 * without booting Wrangler or Playwright browsers.
 */
export async function startL2FakeExternals() {
    const fake = createFakeExternalsServer();
    const { origin } = await fake.start();

    async function setFaultMode(patch) {
        const res = await fetch(`${origin}/__control`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(patch),
        });
        if (!res.ok) throw new Error(`Failed to update L2 fake-externals: ${res.status}`);
        return res.json();
    }

    async function getControlState() {
        const res = await fetch(`${origin}/__control`);
        if (!res.ok) throw new Error(`Failed to read L2 fake-externals: ${res.status}`);
        return res.json();
    }

    return {
        origin,
        setFaultMode,
        getControlState,
        async close() {
            await fake.stop();
        },
    };
}
