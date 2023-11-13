import {
	CancellationToken,
	DocumentSymbol,
	ExtensionContext,
	Location,
	TestController,
	TestItem,
	TestMessage,
	TestRun,
	TestRunRequest,
	TextDocument,
	TextEditor,
	WorkspaceConfiguration,
	window
} from 'vscode';
import { GoExtensionContext } from '../context';
import { GoTestProfiler, ProfilingOptions } from '../goTest/profile';
import { GoTestResolver } from '../goTest/resolve';
import { GoTestRunner, RunConfig, TestRunOutput } from '../goTest/run';
import { dispose, GoTest, Workspace } from '../goTest/utils';
import { goTestWithBazel, bazelDebugTestAtCursor, ExitCode } from '../bazel/bazelTestUtils';
import { extractInstanceTestName, GoTestOutput } from '../testUtils';
import fs = require('fs');
import { GoCoverageHandler } from './bazelCoverage';
import { createRegisterCommand } from '../commands';

export class BazelGoTestRunner extends GoTestRunner {
	private readonly coverageHandler: GoCoverageHandler;
	constructor(
		protected readonly goCtx: GoExtensionContext,
		protected readonly workspace: Workspace,
		protected readonly ctrl: TestController,
		protected readonly resolver: GoTestResolver,
		protected readonly profiler: GoTestProfiler
	) {
		super(goCtx, workspace, ctrl, resolver, profiler);
		this.coverageHandler = new GoCoverageHandler();
	}

	/**
	 * If coverage is enabled, this executes the coverage handler.
	 * Then it calls GoTestRunner.run with the given args
	 */
	async run(request: TestRunRequest, token?: CancellationToken, options: ProfilingOptions = {}) {
		this.coverageHandler.newRun(this.goCtx.coverageEnabled);
		// If any test methods are present (e.g. from testify), GoTestRunner.run includes logic that attempts to add their parent test suite to the run as well.
		// However, with Bazel this is not necessary as the test filter will ensure the correct test cases are run.
		// In order to avoid triggering this logic, remove these from isTestMethod for the duration of this run.
		// This workaround allows us to avoid re-implementing the entire run function for just this one adjustment.
		const removedItems: TestItem[] = [];
		request.include?.forEach((item) => {
			if (this.resolver.isTestMethod.has(item)) {
				this.resolver.isTestMethod.delete(item);
				removedItems.push(item);
			}
			this.recursivelyClearTestSuiteSubtests(item);
		});
		const success = await super.run(request, token, options);
		removedItems.forEach((item) => this.resolver.isTestMethod.add(item));
		return success;
	}

	/**
	 * Execute test with a guarantee it will be run with coverage enabled
	 * this calls BazelGoTestRunner.run with the given args, with the goCtx temporarily enabled
	 **/
	async runWithCoverage(
		request: TestRunRequest,
		token?: CancellationToken,
		options: ProfilingOptions = {}
	): Promise<boolean> {
		const preservedCoverageState = this.goCtx.coverageEnabled;
		this.goCtx.coverageEnabled = true;
		const success = await this.run(request, token, options);
		this.goCtx.coverageEnabled = preservedCoverageState;
		return success;
	}

	/**
	 * Overrides runGoTest to run the test using Bazel.
	 *
	 * @param config RunConfig for the test that has been clicked.
	 */
	protected async runGoTest(config: RunConfig): Promise<boolean> {
		const { run, pkg, functions, record, concat, ...rest } = config;
		if (Object.keys(functions).length === 0) return true;

		const complete = new Set<TestItem>();
		const outputChannel = new TestRunOutput(run);
		const runFunctions: string[] = [];

		// Convert Testify suite methods into subtest format (e.g. MyTestSuite/TestCase1).
		Object.keys(functions).forEach((testFunctionName: string) => {
			const currentTestCase = functions[testFunctionName];
			runFunctions.push(this.formatTestCaseForFilter(testFunctionName, currentTestCase));
		});

		const testOutcome = await goTestWithBazel(
			{
				...rest,
				outputChannel,
				dir: pkg.uri?.fsPath ?? '',
				functions: runFunctions,
				goTestOutputConsumer: !rest.isBenchmark
					? (e) => this.consumeGoTestEvent(run, functions, record, complete, concat, e)
					: undefined,
				applyCodeCoverage: this.goCtx.coverageEnabled
			},
			undefined,
			this.coverageHandler
		);

		// One-time-use wrapper around showErrorMessage. Displays a message only on its first call.
		const showErrorOnce = (() => {
			let shown = false;
			return (message: string) => {
				!shown && window.showErrorMessage(message);
				shown = true;
			};
		})();

		switch (testOutcome.exitCode) {
			case ExitCode.Success:
				if (rest.isBenchmark) {
					window.showInformationMessage('Benchmark complete. See terminal for results.');
					this.markComplete(functions, complete, (x) => run.passed(x));
					return true;
				}

				this.markComplete(functions, complete, (x) => {
					showErrorOnce(
						'Some test cases were skipped. If you renamed or removed a subtest, please re-run the whole test case to update all subtests.'
					);
					run.skipped(x);
				});
				return true;
			case ExitCode.BuildFailed:
				window.showErrorMessage('Unable to run selected tests due to build errors.');
				this.markComplete(functions, complete, (item) => {
					run.errored(item, {
						message: testOutcome.message || 'Build error. Please see console output for further details.'
					});
					item.error = 'Build errors';
				});
				break;
			case ExitCode.Interrupted:
				window.showWarningMessage('Bazel interrupted during test run. Incomplete tests marked as skipped.');
				this.markComplete(functions, complete, (x) => run.skipped(x));
				break;
			case ExitCode.CommandLineProblem:
				window.showWarningMessage(
					'Bazel argument error. Please check the following VS Code settings for any values that are incompatible with Bazel: go.testFlags, go.testEnvVars.'
				);
				this.markComplete(functions, complete, (x) => run.skipped(x));
				break;
			default:
				// Remaining tests will be marked as errored so that they are flagged with an error message and console link.
				// If all tests were already marked during the GoTestWithBazel call above, then no actual updates will occur here.
				this.markComplete(functions, complete, (item) => {
					showErrorOnce(`Bazel Exit Code: ${testOutcome.exitCode}. This test run is incomplete.`);
					outputChannel.show();
					run.errored(item, {
						message:
							testOutcome.message || 'Other Bazel error. Please see console output for further details.'
					});
					item.error = 'Bazel errors';
				});
				break;
		}

		return false;
	}

	/**
	 * Initiates a debug session using an alternate Bazel-specific debug function.
	 *
	 * @param request TestRunRequest for the test that has been clicked.
	 * @param token CancellationToken to cancel the debug request.
	 */
	async debug(request: TestRunRequest, token?: CancellationToken) {
		await super.debug(
			request,
			token,
			(
				editorOrDocument: TextEditor | TextDocument,
				testFunctionName: string,
				testFunctions: DocumentSymbol[],
				goConfig: WorkspaceConfiguration,
				sessionID?: string
			) => this.bazelDebug(editorOrDocument, testFunctionName, testFunctions, goConfig, sessionID)
		);
	}

	/**
	 * Wrapper to generate the correct arguments to bazelDebugTestAtCursor, based on the current state of test cases in this class.
	 * @param editorOrDocument The text document (or editor) that defines the test.
	 * @param testFunctionName The name of the test function.
	 * @param testFunctions All test function symbols defined by the document.
	 * @param goConfig Go configuration, i.e. flags, tags, environment, etc.
	 * @param sessionID If specified, `sessionID` is added to the debug configuration and can be used to identify the debug session.
	 * @returns Promise that resolves to a boolean indicating whether the debug session was successfully started.
	 */
	async bazelDebug(
		editorOrDocument: TextEditor | TextDocument,
		testFunctionName: string,
		testFunctions: DocumentSymbol[],
		goConfig: WorkspaceConfiguration,
		sessionID?: string
	) {
		const doc = 'document' in editorOrDocument ? editorOrDocument.document : editorOrDocument;

		// Get all test cases in the document, find the match, and format it for the filter.
		// This is currently done only to ensure that testify suite methods are in the right format.
		const testItemId = GoTest.id(doc.uri, 'test', testFunctionName);
		const testCase = this.resolver.find(doc.uri).find((value) => value.id === testItemId);
		const runFunction = this.formatTestCaseForFilter(testFunctionName, testCase);

		return await bazelDebugTestAtCursor(editorOrDocument, runFunction, testFunctions, goConfig, sessionID);
	}

	/**
	 * Updates the test run with the outcomes of tests, triggering output to the user.
	 * Extends the super class with support for 'errored' events, which appear in the Bazel test outputs when there is a runtime error such as a panic.
	 * Adjusts behavior from the super class for 'fail' events, by adding a check to overlay error messages only on existing files.
	 * @param run TestRun to update
	 * @param tests Maps test ID string to its associated TestItem.
	 * @param record Maps test ID string to all output messages, accumulating messages for each test as they are processed.
	 * @param complete Set<TestItem> containing all completed test items.
	 * @param concat Boolean indicates whether failure messages should be concatenated.
	 * @param e GoTestOutput event to process.
	 */
	consumeGoTestEvent(
		run: TestRun,
		tests: Record<string, TestItem>,
		record: Map<string, string[]>,
		complete: Set<TestItem>,
		concat: boolean,
		e: GoTestOutput
	) {
		const test = e.Test && this.resolveTestName(tests, e.Test);
		if (!test) return;

		switch (e.Action) {
			case 'fail': {
				complete.add(test);
				const messages = this.parseOutput(test, record.get(test.id) || []);

				if (!concat) {
					run.failed(test, messages, (e.Elapsed ?? 0) * 1000);
					break;
				}

				const merged = new Map<string, TestMessage>();
				let lastValidLoc: Location | undefined;
				for (const { message, location } of messages) {
					const loc = `${location?.uri}:${location?.range.start.line}`;
					if (merged.has(loc)) {
						// If location is already in progress, add to the message.
						merged.get(loc)!.message += '\n' + message;
					} else if (location && fs.existsSync(location.uri.fsPath)) {
						// The first time a new location is seen, confirm that the file exists before starting a message at that location.
						merged.set(loc, { message, location });
						// This becomes the last known valid location (most relevant location to overlay messages that originate from generated code).
						lastValidLoc = location;
					} else {
						// If the location's uri does not point to an accessible file, start a message using the last valid location.
						// This will show the message at the location of the call that leads to the error.
						merged.set(loc, { message, location: lastValidLoc });
					}
				}

				run.failed(test, Array.from(merged.values()), (e.Elapsed ?? 0) * 1000);
				break;
			}
			case 'errored':
				complete.add(test);
				run.errored(test, { message: record.get(test.id)?.join('') || 'Error occurred.  See console output.' });
				break;
			default:
				// All other actions defer to the GoTestRunner super class logic.
				super.consumeGoTestEvent(run, tests, record, complete, concat, e);
				break;
		}
	}

	/**
	 * registers the 'go.test.coverage.bazel' command in vscode, binding the vscode command to the BazelGoTestRunner this method is executed with
	 * @param extensionCtx { vscode.ExtensionContext } used to register the command
	 */
	async registerCoverageCommand(extensionCtx: ExtensionContext) {
		const registerCommand = createRegisterCommand(extensionCtx, this.goCtx);
		registerCommand('go.test.coverage.bazel', () => async (testItem: TestItem) => {
			await this.runWithCoverage(new TestRunRequest([testItem], undefined, undefined));
		});
	}

	/**
	 * Registers the 'go.test.package.bazel' command, which will resolve all tests in the currently open package and then run them.
	 * @param extensionCtx { vscode.ExtensionContext } used to register the command
	 */
	async registerTestPackageCommand(extensionCtx: ExtensionContext) {
		const registerCommand = createRegisterCommand(extensionCtx, this.goCtx);
		registerCommand('go.test.package.bazel', () => async () => {
			const file = window.activeTextEditor?.document.uri;
			if (!file) {
				window.showErrorMessage('No open file was found.');
				return;
			}

			const fileTestItem = await this.resolver.getFile(file);
			if (fileTestItem.parent && GoTest.parseId(fileTestItem.parent.id).kind === 'package') {
				await this.resolver.resolve(fileTestItem.parent);
				await this.run(new TestRunRequest([fileTestItem.parent], undefined, undefined));
				return;
			}

			window.showErrorMessage('Unable to determine the package for this file. Please open a valid Go file.');
		});
	}

	/**
	 * Adds additional filtering before parsing the output using the parseOutput method from the super class.
	 *
	 * @param test TestItem for which output will be processed.
	 * @param output Full test output for the test item.
	 * @returns TestMessage[] containing the filtered message output to be displayed to the user for this test item.
	 */
	parseOutput(test: TestItem, output: string[]): TestMessage[] {
		// Add additional custom filtering of the test error messages.
		const filteredOutput = output.filter(
			// Remove log messages (e.g. '2023-02-02T16:09:58.913Z\tINFOt') before generating the output messages.
			(line) => !line.match(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z\t(DEBUG|INFO|ERROR|WARN)\t/)
		);

		// Apply existing logic from the Go extension to the filtered output.
		return super.parseOutput(test, filteredOutput);
	}

	/**
	 * Adds additional logic to GoTestRunner.resolveTestName method, to handle parsing of events from test suite methods.
	 * This is performed as an additional check before running the existing logic in the super class if no match is found.
	 * @param tests mapping of test names to TestItem for the run.
	 * @param name name to be resolved to a TestItem.
	 * @returns TestItem that corresponds to the name, otherwise undefined.
	 */
	resolveTestName(tests: Record<string, TestItem>, name: string): TestItem | undefined {
		if (!name) {
			return;
		}

		// When Bazel runs a test suite, the results are provided in the format of subtest results, e.g. MySuite/TestCase1
		// tests will contain keys in the format of (*suiteType).TestCaseName, so the logic below will convert and check for matches.
		for (const existingTestName of Object.keys(tests)) {
			const testSuiteMethodName = extractInstanceTestName(existingTestName);
			const parent = tests[existingTestName].parent;

			if (parent && this.resolver.isTestSuiteFunc.has(parent) && testSuiteMethodName) {
				const suiteName = GoTest.parseId(parent.id).name;
				if (name === `${suiteName}/${testSuiteMethodName}`) return tests[existingTestName];
				else if (name.startsWith(`${suiteName}/${testSuiteMethodName}/`)) {
					const start = `${suiteName}/${testSuiteMethodName}/`.length;
					return this.resolveSubtest(tests[existingTestName], name, start);
				}
			}

			// If this case is a suite, then check if any of its children contain the matching test case.
			if (this.resolver.isTestSuiteFunc.has(tests[existingTestName])) {
				let matchingChild: TestItem | undefined;

				// Using forEach instead of for loop as TestItemCollection does not have full iterable support.
				tests[existingTestName].children.forEach((child) => {
					const testMethodName = `${existingTestName}/${extractInstanceTestName(
						GoTest.parseId(child.id).name || ''
					)}`;
					if (name === testMethodName) matchingChild = child;
					else if (name.startsWith(`${testMethodName}/`)) {
						matchingChild = this.resolveSubtest(child, name, testMethodName.length + 1);
					}
				});
				if (matchingChild) return matchingChild;
			}
		}

		// All other situations follow existing logic from super class.
		return super.resolveTestName(tests, name);
	}

	/**
	 * Formats the function name into Testify suite methods into subtest format (e.g. MyTestSuite/TestCase1).
	 * @param testFunctionName Function name that will be returned as-is if it is determined that no reformatting is needed.
	 * @param currentTestCase Test case which will be used to perform the conversion into subtest format if necessary.
	 * @returns
	 */
	formatTestCaseForFilter(testFunctionName: string, currentTestCase: TestItem | undefined) {
		if (!currentTestCase) return testFunctionName;

		const testSuiteMethodName = extractInstanceTestName(testFunctionName);
		const parent = currentTestCase.parent;
		if (parent && this.resolver.isTestSuiteFunc.has(parent) && testSuiteMethodName) {
			const suiteName = GoTest.parseId(parent.id).name;
			return `${suiteName}/${testSuiteMethodName}`;
		}

		return testFunctionName;
	}

	/**
	 * Recursively check if a test item or any of its children represent a test suite, and if so, clear the subtests beneath each test case.
	 * When a test suite is present, subtests are nested a layer deeper than expected by the subtest cleanup logic that covers other cases, so this separate method is needed.
	 * @param item TestItem from which any subtests will be recursively cleared, if it is a test suite.
	 */
	private recursivelyClearTestSuiteSubtests(item: TestItem): void {
		// TestItem parent-child structure when a test suite is present: Workspace -> Package -> File -> Test Suite -> Test Case -> Subtest

		// Base Case 1: This is a test suite function [clear the subtests beneath each test case, 2 levels away].
		if (this.resolver.isTestSuiteFunc.has(item)) {
			item.children.forEach((testCase: TestItem) => {
				testCase.children.forEach((subTest: TestItem) => {
					if (this.resolver.isDynamicSubtest.has(subTest)) dispose(this.resolver, subTest);
				});
			});
			return;
		}

		// Base Case 2: Non-test suite function with no children [do nothing].

		// Recursive Case: Non-test suite function with children [check if any of the children contain test suites].
		item.children.forEach((child: TestItem) => {
			// Continue traversal only if this child is not a dynamic subtest.
			if (!this.resolver.isDynamicSubtest.has(child)) this.recursivelyClearTestSuiteSubtests(child);
		});
	}

	/**
	 * Recursively resolves a subtest from a test case, given the name of the subtest. Creates new subtests if not existing.
	 * @param parent TestItem for the test case that contains the subtest.
	 * @param name Name of the subtest to be resolved.
	 * @param start Character index to start parsing the name from, representing the end of the parent test case name.
	 * @param segmentEnd Character at which to end parsing of the name, representing the end of the current subtest name.
	 * @returns TestItem that corresponds to the name, otherwise undefined.
	 */
	private resolveSubtest(parent: TestItem, name: string, start: number, segmentEnd?: number): TestItem | undefined {
		// If no segmentEnd is provided, begin with the first segment after the start index.
		if (!segmentEnd) segmentEnd = name.indexOf('/', start);
		if (segmentEnd === -1) segmentEnd = name.length;
		const currentSubtest = this.resolver.getOrCreateSubTest(
			parent,
			name.substring(0, segmentEnd),
			name.substring(0, segmentEnd),
			true
		);

		// If any '/' remains between start and the end of the string, resolve those children first.
		if (currentSubtest && name.charAt(segmentEnd) === '/') {
			// Advance the end to the next '/', or -1 if the next segment goes to the end.
			const newEnd = name.indexOf('/', segmentEnd + 1);
			return this.resolveSubtest(currentSubtest, name, start, newEnd);
		}

		return currentSubtest;
	}
}
