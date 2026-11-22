// Runs the issue's steps in the real app: select text, drag the scrollbar, then copy.
const { execFileSync } = require('child_process');
const fs = require('fs');
const { createRequire } = require('module');
const path = require('path');
const { chromium } = createRequire(path.join(process.cwd(), 'package.json'))('playwright-core');

const [variant, outFile] = process.argv.slice(2);
const isMac = process.platform === 'darwin';
const TREE = '.repl .repl-tree';
const ROWS = `${TREE} .monaco-list-row`;
const result = { variant, platform: process.platform, passed: false };
const save = () => fs.writeFileSync(outFile, JSON.stringify(result, null, 1));

// A hang is the expected outcome without the fix, so it counts as reproducing the bug there.
setTimeout(() => {
	result.hung = true;
	result.bugReproduced = variant === 'before';
	save();
	process.exit(variant === 'before' ? 0 : 3);
}, 15 * 60 * 1000).unref();

const clipboardOptions = { encoding: 'utf8', maxBuffer: 1 << 26, timeout: 15000 };
const readClipboard = () => isMac
	? execFileSync('pbpaste', clipboardOptions)
	: execFileSync('xclip', ['-selection', 'clipboard', '-o'], clipboardOptions);
const clearClipboard = () => execFileSync(isMac ? 'pbcopy' : 'xclip', isMac ? [] : ['-selection', 'clipboard', '-i'], { input: 'sentinel', stdio: ['pipe', 'ignore', 'ignore'], timeout: 5000 });

async function waitForClipboardChange() {
	let text = readClipboard();
	for (let attempt = 0; attempt < 12 && text === 'sentinel'; attempt++) {
		await new Promise(resolve => setTimeout(resolve, 500));
		text = readClipboard();
	}
	return text;
}

function summarize(text) {
	const numbers = text.split(/\r?\n/).map(line => line.trim().match(/^\d+/)?.[0]).filter(value => value !== undefined).map(Number);
	let gaps = 0;
	for (let i = 1; i < numbers.length; i++) {
		if (numbers[i] !== numbers[i - 1] + 1) {
			gaps++;
		}
	}
	return { characters: text.length, lines: numbers.length, first: numbers[0], last: numbers.at(-1), gaps };
}

async function findWorkbench(browser) {
	for (let attempt = 0; attempt < 60; attempt++) {
		const page = browser.contexts().flatMap(context => context.pages()).find(candidate => candidate.url().includes('workbench'));
		if (page) {
			return page;
		}
		await new Promise(resolve => setTimeout(resolve, 1000));
	}
	throw new Error('workbench page not found');
}

async function main() {
	const browser = await chromium.connectOverCDP('http://127.0.0.1:9333', { timeout: 120000 });
	const page = await findWorkbench(browser);
	const screenshot = name => page.screenshot({ path: outFile.replace(/\.json$/, `-${name}.png`), timeout: 60000 }).catch(() => undefined);
	await page.waitForSelector('.monaco-workbench .part.editor', { timeout: 180000 });
	await page.waitForTimeout(20000);
	await page.bringToFront();

	for (let attempt = 0; attempt < 4 && !(await page.locator(ROWS).count()); attempt++) {
		await page.keyboard.press('F5');
		await page.waitForSelector(ROWS, { timeout: 45000 }).catch(() => undefined);
	}
	await page.waitForSelector(ROWS, { timeout: 30000 });

	const box = await page.locator(TREE).boundingBox();
	const rowCount = () => page.locator(ROWS).count();
	const frame = () => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
	const dragTo = async (fraction, steps, onStep) => {
		await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
		await page.waitForTimeout(200);
		const track = await page.locator(`${TREE} .scrollbar.vertical`).first().boundingBox();
		const slider = await page.locator(`${TREE} .scrollbar.vertical .slider`).first().boundingBox();
		const x = slider.x + slider.width / 2;
		const fromY = slider.y + slider.height / 2;
		const toY = track.y + slider.height / 2 + fraction * (track.height - slider.height);
		await page.mouse.move(x, fromY);
		await page.mouse.down();
		for (let step = 1; step <= steps; step++) {
			const started = Date.now();
			await page.mouse.move(x, fromY + (toY - fromY) * step / steps);
			await frame();
			onStep?.(Date.now() - started);
		}
		await page.mouse.up();
		await page.waitForTimeout(300);
	};
	const visibleRows = () => page.evaluate(({ selector, bounds }) => [...document.querySelectorAll(selector)]
		.map(row => ({ index: Number(row.dataset.index), rect: row.getBoundingClientRect() }))
		.filter(row => row.rect.top >= bounds.y && row.rect.bottom <= bounds.y + bounds.height)
		.map(row => ({ index: row.index, y: row.rect.y + row.rect.height / 2 })), { selector: ROWS, bounds: box });

	let lastIndex = -1;
	for (let attempt = 0; attempt < 120; attempt++) {
		await dragTo(1, 4);
		const index = Math.max(...(await visibleRows()).map(row => row.index));
		if (index === lastIndex && index >= 9900) {
			break;
		}
		lastIndex = index;
		await page.waitForTimeout(2000);
	}
	result.outputRows = lastIndex + 1;
	result.rowsWithoutSelection = await rowCount();

	let firstRow;
	for (let attempt = 0; attempt < 5 && !firstRow; attempt++) {
		await dragTo(0, 8);
		firstRow = (await visibleRows()).find(row => row.index === 1);
	}
	if (!firstRow) {
		throw new Error('could not scroll to the first rows');
	}
	const textBox = await page.locator(`${ROWS}[data-index="1"] .monaco-tl-contents`).first().boundingBox();
	await page.mouse.move(textBox.x + 1, firstRow.y);
	await page.mouse.down();
	await page.mouse.move(textBox.x + 40, firstRow.y, { steps: 4 });
	await page.mouse.up();
	result.selectedText = await page.evaluate(() => getSelection().toString());
	save();

	const stepTimes = [];
	const scrollStarted = Date.now();
	await dragTo(1, 40, time => {
		stepTimes.push(time);
		result.stepsCompleted = stepTimes.length;
		save();
	});
	result.scroll = {
		rowsInDomAtBottom: await rowCount(),
		averageStepMs: Math.round(stepTimes.reduce((a, b) => a + b, 0) / stepTimes.length),
		slowestStepMs: Math.max(...stepTimes),
		totalMs: Date.now() - scrollStarted
	};
	await screenshot('scrolled');
	save();

	if (variant === 'before') {
		result.bugReproduced = result.scroll.rowsInDomAtBottom > 5000;
		result.passed = result.bugReproduced;
		save();
		await browser.close();
		return;
	}

	const nativeCopy = async () => {
		clearClipboard();
		await page.evaluate(selector => {
			window.__copyRows = undefined;
			window.addEventListener('copy', () => { window.__copyRows = document.querySelectorAll(selector).length; }, { once: true });
		}, ROWS);
		await page.keyboard.press(isMac ? 'Meta+C' : 'Control+C');
		await page.waitForTimeout(1000);
		let method = 'keyboard';
		if (await page.evaluate(() => window.__copyRows === undefined)) {
			method = 'execCommand';
			await page.evaluate(() => document.execCommand('copy'));
			await page.waitForTimeout(1000);
		}
		return { method, rowsDuringCopy: await page.evaluate(() => window.__copyRows), ...summarize(readClipboard()) };
	};

	result.shortCopy = await nativeCopy();
	save();

	const bottomRows = await visibleRows();
	const target = bottomRows[bottomRows.length - 2];
	const shiftKey = 'Shift';
	await page.keyboard.down(shiftKey);
	await page.mouse.click(textBox.x + 20, target.y);
	await page.keyboard.up(shiftKey);
	await page.waitForTimeout(300);
	await dragTo(0.5, 8);
	result.rowsInDomMidSelection = await rowCount();
	result.targetRow = target.index;

	result.fullCopy = await nativeCopy();
	await page.waitForTimeout(300);
	result.rowsAfterCopy = await rowCount();
	await screenshot('copied');
	save();

	const middle = await visibleRows();
	clearClipboard();
	await page.mouse.click(textBox.x + 20, middle[Math.floor(middle.length / 2)].y, { button: 'right' });
	await page.waitForTimeout(800);
	await screenshot('context-menu');
	const copyItem = page.locator('.context-view .monaco-menu .action-label:visible', { hasText: /^Copy$/ }).first();
	if (await copyItem.count()) {
		await copyItem.click();
		result.menuCopy = summarize(await waitForClipboardChange());
		result.menuClosedAfterCopy = !(await page.locator('.context-view .monaco-menu').first().isVisible().catch(() => false));
	} else {
		result.menuCopy = 'menu item not found';
	}
	result.selectionAfterMenuCopy = await page.evaluate(() => getSelection().toString().length);

	// Copy All uses the same clipboard service but no selection code, so it shows whether this machine can observe it.
	clearClipboard();
	await page.mouse.click(textBox.x + 20, middle[Math.floor(middle.length / 2)].y, { button: 'right' });
	await page.waitForTimeout(800);
	const copyAllItem = page.locator('.context-view .monaco-menu .action-label:visible', { hasText: /^Copy All$/ }).first();
	if (await copyAllItem.count()) {
		await copyAllItem.click();
		const text = await waitForClipboardChange();
		result.copyAllControl = { clipboardChanged: text !== 'sentinel', ...summarize(text) };
	} else {
		result.copyAllControl = 'menu item not found';
	}

	const rowLimit = result.rowsWithoutSelection + 4;
	const copiedAll = copy => copy.lines >= target.index - 2 && copy.gaps <= 1;
	result.checks = {
		scrollStaysVirtualized: result.scroll.rowsInDomAtBottom <= rowLimit,
		shortCopyStaysVirtualized: result.shortCopy.rowsDuringCopy <= rowLimit && result.shortCopy.characters > 0,
		midSelectionStaysVirtualized: result.rowsInDomMidSelection <= rowLimit,
		keyboardCopyComplete: copiedAll(result.fullCopy),
		rowsReleasedAfterCopy: result.rowsAfterCopy <= rowLimit,
		contextMenuCopyComplete: typeof result.menuCopy === 'object' && copiedAll(result.menuCopy)
	};
	result.passed = Object.values(result.checks).every(Boolean);
	save();
	await browser.close();
	process.exit(result.passed ? 0 : 1);
}

main().catch(error => {
	result.error = String(error?.stack ?? error);
	save();
	process.exit(variant === 'before' ? 0 : 1);
});
