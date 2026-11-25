import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { CHILLIN_ROOT } from '../env/ports.mjs';

class Statement {
    constructor(db, sql, args = []) {
        this.db = db;
        this.sql = sql;
        this.args = args;
    }

    bind(...args) {
        const normalized = args.map((v) => {
            if (v === undefined) return null;
            if (typeof v === 'boolean') return v ? 1 : 0;
            return v;
        });
        return new Statement(this.db, this.sql, normalized);
    }

    async first() {
        const stmt = this.db.prepare(this.sql);
        const row = stmt.get(...this.args);
        return row === undefined ? null : row;
    }

    async all() {
        const stmt = this.db.prepare(this.sql);
        return { results: stmt.all(...this.args) };
    }

    async run() {
        const stmt = this.db.prepare(this.sql);
        const info = stmt.run(...this.args);
        return {
            success: true,
            meta: {
                changes: info.changes,
                last_row_id: Number(info.lastInsertRowid || 0),
            },
        };
    }
}

/**
 * Opens an isolated in-memory SQLite D1-compatible DB and applies all Chillin migrations.
 */
export function openMigratedLocalD1() {
    const db = new DatabaseSync(':memory:');
    const migDir = path.join(CHILLIN_ROOT, 'migrations');
    const files = fs.readdirSync(migDir).filter((f) => f.endsWith('.sql')).sort();
    for (const f of files) {
        const sql = fs.readFileSync(path.join(migDir, f), 'utf8');
        db.exec(sql);
    }
    return {
        raw: db,
        prepare(sql) {
            return new Statement(db, sql);
        },
        async batch(stmts) {
            const out = [];
            for (const s of stmts) out.push(await s.run());
            return out;
        },
        close() {
            db.close();
        },
    };
}
