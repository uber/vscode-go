/*---------------------------------------------------------
 * Copyright 2021 The Go Authors. All rights reserved.
 * Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------*/
import path = require('path');
import { DocumentSymbol, FileType, Uri, TextDocument, SymbolKind, Range, Position } from 'vscode';
import { packagePathToGoModPathMap } from '../../src/goModules';
import { GoTestExplorer } from '../../src/goTest/explore';
import { Workspace } from '../../src/goTest/utils';
import { MockTestWorkspace } from '../mocks/MockTest';

// eslint-disable-next-line @typescript-eslint/no-unused-vars
export function getSymbols_Regex(doc: TextDocument, token: unknown): Thenable<DocumentSymbol[]> {
	const syms: DocumentSymbol[] = [];
	const range = new Range(new Position(0, 0), new Position(0, 0));
	doc.getText().replace(/^func (Test|Benchmark|Example|Fuzz)([A-Z]\w+)(\(.*\))/gm, (m, type, name, details) => {
		syms.push(new DocumentSymbol(type + name, details, SymbolKind.Function, range, range));
		return m;
	});
	doc.getText().replace(
		// Match suite methods and include them in the symbols.
		/^func \(s \*([A-Za-z_]\w*)\) (Test[A-Z]\w+)(\(.*\))/gm,
		(m, suiteName, testName, details) => {
			const fullName = `(*${suiteName}).${testName}`;
			syms.push(new DocumentSymbol(fullName, details, SymbolKind.Method, range, range));
			return m;
		}
	);

	// Updates below below to support testify test case scenarios:
	// 1) Match suite methods in the input text and include as symbols.
	// 2) Match testify suite import and include as symbol.
	// 3) Instead of returning flat symbols, return them as children of the package.
	doc.getText().replace(/github\.com\/stretchr\/testify\/suite/gm, (m, type, name, details) => {
		syms.push(
			new DocumentSymbol('"github.com/stretchr/testify/suite"', details, SymbolKind.Namespace, range, range)
		);
		return m;
	});

	const packageSym = new DocumentSymbol('a', 'package', SymbolKind.Package, range, range);
	packageSym.children = syms;
	return Promise.resolve([packageSym]);
}

export function populateModulePathCache(workspace: MockTestWorkspace) {
	function walk(dir: Uri, modpath?: string) {
		const dirs: Uri[] = [];
		for (const [name, type] of workspace.fs.dirs.get(dir.toString()) ?? []) {
			const uri = Uri.file(path.join(dir.fsPath, name));
			if (type === FileType.Directory) {
				dirs.push(uri);
			} else if (name === 'go.mod') {
				modpath = dir.fsPath;
			}
		}
		packagePathToGoModPathMap[dir.fsPath] = modpath || '';
		for (const dir of dirs) {
			walk(dir, modpath);
		}
	}

	// prevent getModFolderPath from actually doing anything;
	for (const pkg in packagePathToGoModPathMap) {
		delete packagePathToGoModPathMap[pkg];
	}
	walk(Uri.file('/'));
}

export async function forceDidOpenTextDocument(
	workspace: Workspace,
	testExplorer: GoTestExplorer,
	uri: Uri
): Promise<TextDocument> {
	const doc = await workspace.openTextDocument(uri);

	// Force didOpenTextDocument to fire. Without this, the test may run
	// before the event is handled.
	//
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	await (testExplorer as any).didOpenTextDocument(doc);

	return doc;
}
