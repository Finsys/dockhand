/**
 * Database Connection Module
 *
 * Provides a unified database connection using Bun's SQL API.
 * Supports both SQLite (default) and PostgreSQL (via DATABASE_URL).
 */

import { SQL } from 'bun';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Database configuration
const databaseUrl = process.env.DATABASE_URL;
const dataDir = process.env.DATA_DIR || './data';

// Detect database type
export const isPostgres = databaseUrl && (databaseUrl.startsWith('postgres://') || databaseUrl.startsWith('postgresql://'));
export const isSqlite = !isPostgres;

/**
 * Read a SQL file from the appropriate sql directory.
 */
function readSql(filename: string): string {
	const sqlDir = isPostgres ? 'postgres' : 'sqlite';
	return readFileSync(join(__dirname, sqlDir, 'sql', filename), 'utf-8');
}

/**
 * Validate PostgreSQL connection URL format.
 */
function validatePostgresUrl(url: string): void {
	try {
		const parsed = new URL(url);

		if (parsed.protocol !== 'postgres:' && parsed.protocol !== 'postgresql:') {
			exitWithError(`Invalid protocol "${parsed.protocol}". Expected "postgres:" or "postgresql:"`, url);
		}

		if (!parsed.hostname) {
			exitWithError('Missing hostname in DATABASE_URL', url);
		}

		if (!parsed.pathname || parsed.pathname === '/') {
			exitWithError('Missing database name in DATABASE_URL', url);
		}
	} catch {
		exitWithError('Invalid URL format', url);
	}
}

/**
 * Print connection error and exit.
 */
function exitWithError(error: string, url?: string): never {
	console.error('\n' + '='.repeat(70));
	console.error('DATABASE CONNECTION ERROR');
	console.error('='.repeat(70));
	console.error(`\nError: ${error}`);

	if (url) {
		try {
			const parsed = new URL(url);
			if (parsed.password) parsed.password = '***';
			console.error(`\nProvided URL: ${parsed.toString()}`);
		} catch {
			console.error(`\nProvided URL: ${url.replace(/:[^:@]+@/, ':***@')}`);
		}
	}

	console.error('\n' + '-'.repeat(70));
	console.error('DATABASE_URL format:');
	console.error('-'.repeat(70));
	console.error('\n  postgres://USER:PASSWORD@HOST:PORT/DATABASE');
	console.error('\nExamples:');
	console.error('  postgres://dockhand:secret@localhost:5432/dockhand');
	console.error('  postgres://admin:p4ssw0rd@192.168.1.100:5432/dockhand');
	console.error('  postgresql://user:pass@db.example.com/mydb?sslmode=require');
	console.error('\n' + '-'.repeat(70));
	console.error('To use SQLite instead, remove the DATABASE_URL environment variable.');
	console.error('='.repeat(70) + '\n');

	process.exit(1);
}

/**
 * Create the database connection.
 */
function createConnection(): SQL {
	if (isPostgres) {
		// Validate PostgreSQL URL
		validatePostgresUrl(databaseUrl!);

		console.log('Connecting to PostgreSQL database...');
		try {
			const sql = new SQL(databaseUrl!);
			return sql;
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			exitWithError(`Failed to connect to PostgreSQL: ${message}`, databaseUrl);
		}
	} else {
		// SQLite: Ensure db directory exists
		const dbDir = join(dataDir, 'db');
		if (!existsSync(dbDir)) {
			mkdirSync(dbDir, { recursive: true });
		}

		const dbPath = join(dbDir, 'dockhand.db');
		console.log(`Using SQLite database at: ${dbPath}`);

		const sql = new SQL(`sqlite://${dbPath}`);

		// Enable WAL mode for better performance
		sql.run('PRAGMA journal_mode = WAL');

		return sql;
	}
}

/**
 * Initialize the database schema.
 */
async function initializeSchema(sql: SQL): Promise<void> {
	try {
		// Create schema (tables)
		await sql.run(readSql('schema.sql'));

		// Create indexes
		await sql.run(readSql('indexes.sql'));

		// Insert seed data
		await sql.run(readSql('seed.sql'));

		// Update system roles
		await sql.run(readSql('system-roles.sql'));

		// Run maintenance
		await sql.run(readSql('maintenance.sql'));

		console.log(`Database initialized successfully (${isPostgres ? 'PostgreSQL' : 'SQLite'})`);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		console.error('Failed to initialize database schema:', message);
		throw error;
	}
}

// Create and export the database connection
export const sql = createConnection();

// Initialize schema (runs async but we handle it)
initializeSchema(sql).catch((error) => {
	const errorMsg = error instanceof Error ? error.message : String(error);
	console.error('[DB] Database initialization failed:', errorMsg);
	process.exit(1);
});

/**
 * Helper to convert SQLite integer booleans to JS booleans.
 * PostgreSQL returns actual booleans, SQLite returns 0/1.
 */
export function toBool(value: any): boolean {
	if (typeof value === 'boolean') return value;
	return Boolean(value);
}

/**
 * Helper to convert JS boolean to database value.
 * PostgreSQL uses boolean, SQLite uses 0/1.
 */
export function fromBool(value: boolean): boolean | number {
	return isPostgres ? value : (value ? 1 : 0);
}
