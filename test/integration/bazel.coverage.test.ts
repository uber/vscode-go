import assert = require('assert');
import path = require('path');
import sinon = require('sinon');
import { CoverageTreeNode, GoCoverageHandler, lcovLinesToEditorRanges } from '../../src/bazel/bazelCoverage';
import * as goCover from '../../src/goCover';
import { commands, window } from 'vscode';

suite('convert LCOV results into document decorations', () => {
	const sampleData = {
		found: 110,
		hit: 100,
		details: [
			{ line: 30, hit: 2 },
			{ line: 31, hit: 2 },
			{ line: 32, hit: 2 },
			{ line: 40, hit: 0 },
			{ line: 41, hit: 0 },
			{ line: 42, hit: 0 },
			{ line: 51, hit: 2 },
			{ line: 52, hit: 2 }
		]
	};

	test('Classify lines between uncovered and covered', () => {
		const coverageData = lcovLinesToEditorRanges(sampleData, false);
		assert.strictEqual(coverageData.coveredOptions.length, 5);
		assert.strictEqual(coverageData.uncoveredOptions.length, 3);
	});

	test('Create decorations with correct ranges', () => {
		const coverageData = lcovLinesToEditorRanges(sampleData, false);
		coverageData.uncoveredOptions.forEach(
			(val, i) => assert.strictEqual(val.range.start.line, 39 + i),
			'Line numbering is incorrect'
		);
		coverageData.uncoveredOptions.forEach(
			(val) => assert.strictEqual(val.range.isSingleLine, true),
			'Range is not a single line'
		);

		const expectedCoveredLines = [29, 30, 31, 50, 51];
		coverageData.coveredOptions.forEach(
			(val, i) => assert.strictEqual(val.range.start.line, expectedCoveredLines[i]),
			'Line numbering is incorrect'
		);
		coverageData.coveredOptions.forEach(
			(val) => assert.strictEqual(val.range.isSingleLine, true),
			'Range is not a single line'
		);
	});
});

suite('Coverage Tree View', () => {
	const fixtureDir = path.join(__dirname, '..', '..', '..', 'test', 'testdata', 'coverage');

	let coverageHandler: GoCoverageHandler;
	const sandbox = sinon.createSandbox();

	let clearCoverageStub: sinon.SinonStub;
	let createCoverageDataStub: sinon.SinonStub;
	let executeCommandStub: sinon.SinonStub;
	let showErrorMessageStub: sinon.SinonStub;
	let coveragePathResults: Map<string, goCover.CoverageData> | undefined;
	const rootNodeResults: CoverageTreeNode[] = [];

	setup(() => {
		// Create stubs for functions that will be checked in assertions.
		clearCoverageStub = sandbox.stub(goCover, 'clearCoverage');
		clearCoverageStub.callsFake(() => {});

		// createCoverageData fake function will store its coveragePath argument to coveragePathResults.
		coveragePathResults = undefined;
		createCoverageDataStub = sandbox.stub(goCover, 'createCoverageData');
		createCoverageDataStub.callsFake(
			(pathsToDirs: Map<string, string>, coveragePath: Map<string, goCover.CoverageData>) => {
				coveragePathResults = coveragePath;
			}
		);

		// VS Code API commands, to avoid side effects.
		sandbox.stub(commands, 'registerCommand');
		executeCommandStub = sandbox.stub(commands, 'executeCommand');
		showErrorMessageStub = sandbox.stub(window, 'showErrorMessage');

		// Instead of storing nodes within the private GoCoverageHandler.goCoverageRoots field, instead store them in the local rootNodeResults for analysis.
		rootNodeResults.length = 0;
		sandbox
			// eslint-disable-next-line @typescript-eslint/no-explicit-any
			.stub(GoCoverageHandler.prototype, <any>'addTreeRoot')
			.callsFake((node: CoverageTreeNode) => rootNodeResults.push(node));

		// Instantiate a new GoCoverageHandler to collect data for this run.
		coverageHandler = new GoCoverageHandler();
	});

	teardown(() => {
		sandbox.restore();
	});

	test('Ensure correct actions are taken for a new run', () => {
		coverageHandler.newRun();
		assert(clearCoverageStub.calledOnce);
		assert(executeCommandStub.calledTwice);

		// Check args for the first call: Refresh the tree
		assert.strictEqual(executeCommandStub.args[0][0], 'go.coverageTree.refresh');

		// Check args for the second call: Set the context
		assert.strictEqual(executeCommandStub.args[1][0], 'setContext');
		assert.strictEqual(executeCommandStub.args[1][1], 'go.showCoverage');
		assert.strictEqual(executeCommandStub.args[1][2], true);
	});

	test('Produce document coverage data and tree data from a coverage file', async () => {
		await coverageHandler.processCoverProfile({
			coverProfilePath: path.join(fixtureDir, 'coverage.dat'),
			bazelWorkspaceRoot: '/home/user/my-repo',
			currentGoWorkspace: '/home/user/my-repo/src',
			targetPackages: ['code/project/example/package'],
			generatedFilePrefix: 'bazel-out/k8-fastbuild/src/'
		});
		assert.strictEqual(createCoverageDataStub.callCount, 1);

		// Nodes for the tree view should contain a correctly formed result
		// One parent node
		assert.strictEqual(rootNodeResults.length, 1);
		assert.strictEqual(rootNodeResults[0].displayName, 'code/project/example/package');
		assert.strictEqual(rootNodeResults[0].absolutePath, 'code/project/example/package');
		assert.strictEqual(rootNodeResults[0].lines, 849);
		assert.strictEqual(rootNodeResults[0].hits, 723);
		assert.strictEqual(rootNodeResults[0].children?.length, 2);

		// Two child nodes
		const expectedChildren = [
			{ name: 'foo.go', lines: 590, hits: 479 },
			{ name: 'bar.go', lines: 259, hits: 244 }
		];
		const absPathBase = '/home/user/my-repo/src/code/project/example/package';
		for (let i = 0; i < expectedChildren.length; i++) {
			assert.strictEqual(rootNodeResults[0].children[i]?.displayName, expectedChildren[i].name);
			assert.strictEqual(
				rootNodeResults[0].children[i]?.absolutePath,
				path.join(absPathBase, expectedChildren[i].name)
			);
			assert.strictEqual(rootNodeResults[0].children[i]?.lines, expectedChildren[i].lines);
			assert.strictEqual(rootNodeResults[0].children[i]?.hits, expectedChildren[i].hits);
			assert.strictEqual(rootNodeResults[0].children[i]?.children, undefined);
		}

		// Correct keys are present in the coverage path results
		assert.notStrictEqual(
			coveragePathResults?.get('/home/user/my-repo/src/code/project/example/package/foo.go'),
			undefined
		);
		assert.notStrictEqual(
			coveragePathResults?.get('/home/user/my-repo/src/code/project/example/package/bar.go'),
			undefined
		);
	});

	test('Malformed coverage file should display error message', async () => {
		await coverageHandler.processCoverProfile({
			coverProfilePath: path.join(fixtureDir, 'coverage_malformed.dat'),
			bazelWorkspaceRoot: '/home/user/my-repo',
			currentGoWorkspace: '/home/user/my-repo/src',
			targetPackages: ['code/project/example/package'],
			generatedFilePrefix: 'bazel-out/k8-fastbuild/src/'
		});
		assert.strictEqual(
			showErrorMessageStub.lastCall.args[0],
			'Unable to get coverage data for this run: Failed to parse string'
		);
	});
});
