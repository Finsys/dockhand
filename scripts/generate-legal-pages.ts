#!/usr/bin/env bun
/**
 * Generate static HTML pages for License and Privacy from .txt files
 * This ensures a single source of truth for legal documents
 */

import { readFileSync, writeFileSync } from 'fs';
import { join } from 'path';

const ROOT_DIR = join(import.meta.dir, '..');
const WEBPAGE_DIR = join(ROOT_DIR, 'webpage');

function escapeHtml(text: string): string {
	return text
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;');
}

function generateHtmlPage(title: string, content: string): string {
	return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>${title} - Dockhand</title>
    <link rel="icon" type="image/png" href="images/favicon.png">
    <style>
        * {
            margin: 0;
            padding: 0;
            box-sizing: border-box;
        }
        body {
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Oxygen, Ubuntu, sans-serif;
            background: #0a0a0f;
            color: #e0e0e0;
            line-height: 1.6;
            min-height: 100vh;
        }
        .container {
            max-width: 900px;
            margin: 0 auto;
            padding: 2rem;
        }
        header {
            display: flex;
            align-items: center;
            justify-content: space-between;
            padding: 1rem 0;
            margin-bottom: 2rem;
            border-bottom: 1px solid rgba(255,255,255,0.1);
        }
        .logo-img {
            height: 40px;
        }
        .back-link {
            color: #60a5fa;
            text-decoration: none;
            font-size: 0.9rem;
        }
        .back-link:hover {
            text-decoration: underline;
        }
        h1 {
            font-size: 1.75rem;
            margin-bottom: 1.5rem;
            color: #fff;
        }
        .content {
            background: rgba(255,255,255,0.03);
            border: 1px solid rgba(255,255,255,0.1);
            border-radius: 8px;
            padding: 2rem;
        }
        pre {
            font-family: 'SF Mono', Monaco, 'Cascadia Code', monospace;
            font-size: 0.8rem;
            white-space: pre-wrap;
            word-wrap: break-word;
            color: #c0c0c0;
        }
        footer {
            margin-top: 3rem;
            padding-top: 1.5rem;
            border-top: 1px solid rgba(255,255,255,0.1);
            text-align: center;
            font-size: 0.85rem;
            color: #888;
        }
        footer a {
            color: #60a5fa;
            text-decoration: none;
        }
        footer a:hover {
            text-decoration: underline;
        }
    </style>
</head>
<body>
    <div class="container">
        <header>
            <a href="index.html">
                <img src="images/logo-dark.webp" alt="Dockhand" class="logo-img">
            </a>
            <a href="index.html" class="back-link">&larr; Back to home</a>
        </header>

        <h1>${title}</h1>

        <div class="content">
            <pre>${escapeHtml(content)}</pre>
        </div>

        <footer>
            <p>&copy; 2025-2026 Finsys / Jarek Krochmalski &middot; <a href="https://dockhand.pro">https://dockhand.pro</a></p>
        </footer>
    </div>
</body>
</html>`;
}

// Read the source files
const licenseContent = readFileSync(join(ROOT_DIR, 'LICENSE.txt'), 'utf-8');
const privacyContent = readFileSync(join(ROOT_DIR, 'PRIVACY.txt'), 'utf-8');

// Generate HTML pages
const licenseHtml = generateHtmlPage('License Terms and Conditions', licenseContent);
const privacyHtml = generateHtmlPage('Privacy Policy', privacyContent);

// Write to webpage directory
writeFileSync(join(WEBPAGE_DIR, 'license.html'), licenseHtml);
writeFileSync(join(WEBPAGE_DIR, 'privacy.html'), privacyHtml);

console.log('Generated legal pages:');
console.log('  - webpage/license.html');
console.log('  - webpage/privacy.html');
