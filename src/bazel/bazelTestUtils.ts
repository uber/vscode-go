import cp = require('child_process');
import fs = require('fs');
import hash = require('object-hash');
import os = require('os');
import path = require('path');
import readline = require('readline');
import xml2js = require('xml2js');
import portfinder = require('portfinder');
import protobuf = require('protobufjs');
import vscode = require('vscode');
import {
	cancelRunningTests,
	getTestTargetPackages,
	TestConfig,
	GoTestOutput,
	runningTestProcesses,
	statusBarItem
} from '../testUtils';
import { LineBuffer, resolvePath } from '../util';
import { parseEnvFile } from '../utils/envUtils';
import { expandFilePathInOutput } from '../utils/pathUtils';
import { killProcessTree } from '../utils/processUtils';
import { ExecException } from 'child_process';
import { GoCoverageHandler } from './bazelCoverage';

let BUILD_PROTO: string;
try {
	BUILD_PROTO = require('../../proto/build.proto');
} catch {
	// Fall back to the string below when the above fails (e.g. running in non-bundled mode for unit tests)
	BUILD_PROTO = '../../proto/build.proto';
}

const TEST_NAME_SPECIAL_CHARACTERS = /[.*+?^${}()|[\]\\]/g;

const testOutputChannel = vscode.window.createOutputChannel('Bazel Tests');
testOutputChannel.appendLine('Bazel Test Output');

export enum ExitCode {
	FailedToParse = -1,
	Success = 0,
	BuildFailed = 1,
	CommandLineProblem = 2,
	TestFailed = 3,
	Interrupted = 8
}

export enum BazelCommands {
	Test = 'test',
	Debug = 'debug',
	Coverage = 'coverage',
	Benchmark = 'run'
}

// Information collected during analysis of build events.
export type BuildEventOutputs = {
	testXMLPaths: string[];
	errorMessages: string[];
	exitCode: ExitCode;
	workspaceDirectory: string;
	localExecRoot?: string;
	genDir?: string;
};

// Overall result of a test run using goTestWithBazel.
// success is a distinct field from exit code, as it is returned before an exit code is available during debug sessions.
type RunResult = {
	debugReady?: boolean;
	exitCode?: ExitCode;
	message?: string;
};

// Type definitions for use with the XML test results.
export type TestResultXML = {
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	[key: string]: any;
};

/**
 * Runs Bazel Test and displays results to user.
 *
 * @param testconfig Configuration for this test.
 * @param debugConfig If provided, will launch a debug session for the test instead of running it.
 */
export async function goTestWithBazel(
	testconfig: TestConfig,
	debugConfig?: vscode.DebugConfiguration,
	coverageHandler?: GoCoverageHandler
): Promise<RunResult> {
	const outputChannel = testconfig.outputChannel ? testconfig.outputChannel : testOutputChannel;

	// IDE setup tasks prior to the run.
	if (runningTestProcesses.length < 1) outputChannel.clear();
	if (testconfig.goConfig['disableConcurrentTests'] || debugConfig) await cancelRunningTests();
	if (!testconfig.background) outputChannel.show(true);

	const testType: string = testconfig.isBenchmark ? 'Benchmarks' : 'Tests';

	// compute test target package and generate full args.
	const { targets, currentGoWorkspace } = await getTestTargetPackages(testconfig, outputChannel);
	const bazelTargets = await getBazelTargetsFromPackages(testconfig, targets, currentGoWorkspace, debugConfig);
	const buildEventsFile = path.join(os.tmpdir(), `build_events_${hash(outputChannel.name)}`); // Output channel name provides unique timestamp for temp file.
	const bazelArgs = getBazelArgs(testconfig, bazelTargets, buildEventsFile, debugConfig);

	outputChannel.appendLine(['Running command:', 'bazel', ...bazelArgs].join(' '));

	let testResult = {};
	try {
		testResult = await new Promise<RunResult>((resolve) => {
			// TODO: Add support of test environment variables. IDE-73
			const testProcess = cp.exec(['bazel', ...bazelArgs].join(' '), { cwd: currentGoWorkspace });
			const outBuf = new LineBuffer();
			const errBuf = new LineBuffer();

			testconfig.cancel?.onCancellationRequested(() => killProcessTree(testProcess));

			// bazel test emits test results on stdout
			// TODO: filter and append only relevant lines to improve readability of output. IDE-65.
			outBuf.onLine((line) => {
				outputChannel.appendLine(expandFilePathInOutput(line, testconfig.dir));

				// In debug mode, resolve the promise once the API server is listening, so that the debugger can attach.
				if (debugConfig && line.startsWith('API server listening at:')) resolve({ debugReady: true });
			});

			outBuf.onDone((last) => {
				last && outputChannel.appendLine(expandFilePathInOutput(last, testconfig.dir));
			});

			// bazel test emits build errors on stderr, which contain paths relative to the cwd
			errBuf.onLine((line) => outputChannel.appendLine(expandFilePathInOutput(line, testconfig.dir)));
			errBuf.onDone((last) => last && outputChannel.appendLine(expandFilePathInOutput(last, testconfig.dir)));

			testProcess.stdout?.on('data', (chunk) => outBuf.append(chunk.toString()));
			testProcess.stderr?.on('data', (chunk) => errBuf.append(chunk.toString()));

			statusBarItem.show();

			testProcess.on('close', async () => {
				outBuf.done();
				errBuf.done();

				const index = runningTestProcesses.indexOf(testProcess, 0);
				if (index > -1) runningTestProcesses.splice(index, 1);

				const buildEventOutputs = await processBuildEvents(buildEventsFile, outputChannel);
				if (testconfig.goTestOutputConsumer)
					await processTestResultXML(
						buildEventOutputs.testXMLPaths,
						outputChannel,
						testconfig.goTestOutputConsumer
					);

				if (
					testconfig.applyCodeCoverage &&
					buildEventOutputs.localExecRoot &&
					buildEventOutputs.exitCode === 0 // Combined coverage file is provided only when tests pass.
				) {
					await coverageHandler?.processCoverProfile({
						coverProfilePath: path.join(
							buildEventOutputs.localExecRoot,
							'/bazel-out/_coverage/_coverage_report.dat'
						),
						bazelWorkspaceRoot: buildEventOutputs.workspaceDirectory,
						currentGoWorkspace: currentGoWorkspace,
						targetPackages: targets,
						generatedFilePrefix: buildEventOutputs.genDir || ''
					});
				}

				resolve({
					exitCode: buildEventOutputs.exitCode,
					message: buildEventOutputs.errorMessages.join('\n')
				});

				if (!runningTestProcesses.length) statusBarItem.hide();
			});

			runningTestProcesses.push(testProcess);
		});
	} catch (err) {
		outputChannel.appendLine(`Error: ${testType} failed.`);
		if (err instanceof Error) outputChannel.appendLine((err as Error).message);
	}

	return testResult;
}

export function getBazelTestEnvVars(config: vscode.WorkspaceConfiguration): string[] {
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	const envVars: { [key: string]: any } = {};
	const testEnvConfig = config['testEnvVars'] || {};

	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	let fileEnv: { [key: string]: any } = {};
	let testEnvFile = config['testEnvFile'];
	if (testEnvFile) {
		testEnvFile = resolvePath(testEnvFile);
		try {
			fileEnv = parseEnvFile(testEnvFile);
		} catch (e) {
			console.log(e);
		}
	}

	Object.keys(fileEnv).forEach(
		(key) => (envVars[key] = typeof fileEnv[key] === 'string' ? resolvePath(fileEnv[key]) : fileEnv[key])
	);

	Object.keys(testEnvConfig).forEach(
		(key) =>
			(envVars[key] =
				typeof testEnvConfig[key] === 'string' ? resolvePath(testEnvConfig[key]) : testEnvConfig[key])
	);

	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	return Object.entries(envVars).map((entry: any) => `--test_env=${entry[0]}=${entry[1]}`);
}

/**
 * Get the list of Bazel targets to use for the 'bazel' command.
 *
 * @param packages List of Go packages to convert to Bazel targets.
 * @param debugConfig When provided, this function will provide relevant debug targets.
 * @returns true if the bazel command exited with exit code of 0.
 */
export async function getBazelTargetsFromPackages(
	testconfig: TestConfig,
	packages: string[],
	currentGoWorkspace: string,
	debugConfig?: vscode.DebugConfiguration
): Promise<string[]> {
	const bazelTargets: string[] = [];

	for (const pkg of packages) {
		if (debugConfig) {
			const QueryResult = (await protobuf.load(path.join(__dirname, BUILD_PROTO))).lookupType(
				'blaze_query.QueryResult'
			);
			const debugTarget = await new Promise<string>((resolve) => {
				// processQueryResults contains all post-run processing steps, and is called at the completion of the query process.
				// This will be passed a full copy of the stdout buffer, containing the protobuf encoded results.
				const processQueryResults = (error: ExecException | null, stdout: Buffer) => {
					errBuf.done();
					testOutputChannel.appendLine('INFO: Query complete. Parsing results.');

					try {
						// eslint-disable-next-line @typescript-eslint/no-explicit-any
						const queryResults = <any>QueryResult.decode(stdout);
						for (const target of queryResults.target) {
							// Check each target in the results until we find the first one containing this test's file in its srcs.
							// eslint-disable-next-line @typescript-eslint/no-explicit-any
							const srcs = target.rule.attribute.filter((attr: any) => attr.name === 'srcs')[0];
							const isValidMatch =
								srcs?.stringListValue.filter((item: string) =>
									item.endsWith(`${pkg}:${debugConfig.fileName}`)
								).length > 0;
							if (isValidMatch) {
								testOutputChannel.appendLine(
									'INFO: Matching target found. Using :' + target.rule.name.split(':')[1]
								);
								return resolve(':' + target.rule.name.split(':')[1]);
							}
						}
					} catch (e) {
						testOutputChannel.append('ERROR: Failure while parsing query results.');
					}

					testOutputChannel.appendLine(
						'INFO: Unable to confirm matching target. Substituting :go_default_test.'
					);
					return resolve(':go_default_test');
				};

				// Run Bazel query to get all eligible test targets in the current package.
				const queryString = `'kind("^go_test rule$", tests(${pkg}:all))'`;
				const queryArgs = ['query', queryString, '--tool_tag=vscode-go-bazel', '--output=proto'];
				testOutputChannel.appendLine(['Running command:', 'bazel', ...queryArgs].join(' '));
				const queryProcess = cp.exec(
					['bazel', ...queryArgs].join(' '),
					{
						cwd: currentGoWorkspace,
						encoding: null // Ensures that the callback function is passed unencoded binary data.
					},
					processQueryResults
				);

				// Real-time output of any user-readable data emitted on stderr.
				const errBuf = new LineBuffer();
				errBuf.onLine((line) => testOutputChannel.appendLine(line));
				errBuf.onDone((last) => last && testOutputChannel.appendLine(last));
				queryProcess.stderr?.on('data', (chunk) => errBuf.append(chunk.toString()));

				statusBarItem.show();
			});

			bazelTargets.push(pkg + debugTarget);
			continue;
		}

		// Always use target :all for non-debug sessions since we will run with --build_tests_only.
		// Can consider moving into the query above (tradeoff between time to run query every time vs. potentially building extra test targets).
		bazelTargets.push(pkg + ':all');
	}
	return bazelTargets;
}

/**
 * Get the list of arguments to be added following the 'bazel' command.
 *
 * @param testconfig Configuration for this test
 * @param bazelTargets List of Bazel targets to test
 * @param debugConfig If provided, will provide args to run the test in debug mode.
 * @returns array of Bazel arguments that correspond to the given inputs.
 */
export function getBazelArgs(
	testconfig: TestConfig,
	bazelTargets: string[],
	buildEventsFile: string,
	debugConfig?: vscode.DebugConfiguration
): string[] {
	let bazelCmd: BazelCommands;
	if (debugConfig) bazelCmd = BazelCommands.Debug;
	else if (testconfig.applyCodeCoverage) bazelCmd = BazelCommands.Coverage;
	else if (testconfig.isBenchmark) bazelCmd = BazelCommands.Benchmark;
	else bazelCmd = BazelCommands.Test;
	const bazelArgs: string[] = [bazelCmd];

	switch (bazelCmd) {
		case BazelCommands.Debug:
			if (debugConfig) bazelArgs.push(`--port=${debugConfig.port}`);
			// TODO: flags should be set based on go.toolsEnvVars (IDE-73).
			break;
		case BazelCommands.Coverage:
			bazelArgs.push('--combined_report=lcov', '--@io_bazel_rules_go//go/config:cover_format=lcov');
		/* no break: Coverage will also include all Test flags | eslint-disable no-fallthrough */
		case BazelCommands.Benchmark:
		case BazelCommands.Test:
			bazelArgs.push(
				'--build_tests_only',
				'--test_env=GO_TEST_WRAP_TESTV=1',
				`--build_event_json_file=${buildEventsFile}`,
				'--build_event_json_file_path_conversion=no'
			);
			break;
	}

	bazelArgs.push('--tool_tag=vscode-go-bazel');

	// Apply test filters.
	if (bazelTargets.length === 1 && testconfig.functions) {
		const filterFunctions: string[] = [];

		testconfig.functions.forEach((curr: string) =>
			// Escape special characters and anchor all segments of subtests.
			filterFunctions.push(curr.replace(TEST_NAME_SPECIAL_CHARACTERS, '\\$&').replace('/', '$/^'))
		);
		if (filterFunctions.length === 1) bazelArgs.push(`--test_filter='^${filterFunctions[0]}$'`);
		else bazelArgs.push(`--test_filter='^(${filterFunctions.join('|')})$'`);
	}

	for (const flag of testconfig.flags) bazelArgs.push(flag);

	// TODO: Append additional flags when running a benchmark. IDE-69
	bazelArgs.push(...getBazelTestEnvVars(testconfig.goConfig));
	bazelArgs.push(...bazelTargets);

	// To run a benchmark, pass the -test.bench flag.
	if (testconfig.isBenchmark) bazelArgs.push('-- -test.bench=.');
	return bazelArgs;
}

/**
 * Start the debug server and connect a remote debug session for the given test.
 *
 * @param editorOrDocument The text document (or editor) that defines the test.
 * @param testFunctionName The name of the test function.
 * @param testFunctions All test function symbols defined by the document.
 * @param goConfig Go configuration, i.e. flags, tags, environment, etc.
 * @param sessionID If specified, `sessionID` is added to the debug configuration and can be used to identify the debug session.
 * @returns Whether the debug session was successfully started.
 */

export async function bazelDebugTestAtCursor(
	editorOrDocument: vscode.TextEditor | vscode.TextDocument,
	testFunctionName: string,
	testFunctions: vscode.DocumentSymbol[],
	goConfig: vscode.WorkspaceConfiguration,
	sessionID?: string
) {
	const doc = 'document' in editorOrDocument ? editorOrDocument.document : editorOrDocument;
	const workspaceFolder = vscode.workspace.getWorkspaceFolder(doc.uri);

	const debugPort = await portfinder.getPortPromise();
	const debugConfig: vscode.DebugConfiguration = {
		name: `Bazel Debug ${testFunctionName}`,
		type: 'go',
		request: 'attach',
		debugAdapter: 'dlv-dap',
		mode: 'remote',
		port: debugPort,
		fileName: doc.fileName.replace(path.dirname(doc.fileName) + '/', ''),
		host: '127.0.0.1',
		substitutePath: [
			{
				from: '${env:GOPATH}/src',
				to: 'src'
			},
			{
				from: '${env:GOPATH}/bazel-go-code/external/',
				to: 'external/'
			},
			{
				from: '${env:GOPATH}/bazel-out/',
				to: 'bazel-out/'
			},
			{
				from: '${env:GOPATH}/bazel-go-code/external/go_sdk',
				to: 'GOROOT/'
			}
		],
		sessionID
	};

	// Start the debug server for the required function.
	const runResult = await goTestWithBazel(
		{
			dir: path.dirname(doc.fileName) ?? '',
			functions: [testFunctionName],
			goConfig: goConfig,
			flags: [],
			isMod: false
		},
		debugConfig
	);

	// Start the VS Code debug session and direct the user to the debug UI.
	if (runResult.debugReady) {
		vscode.commands.executeCommand('workbench.debug.action.focusRepl');

		// Listener to terminate the debug server after completion of the debug session.
		vscode.debug.onDidTerminateDebugSession(async (session) => {
			if (session.configuration.sessionID === debugConfig.sessionID) {
				await cp.exec(`kill $(lsof -t -i:${debugConfig.port})`);
				// Return the user to the testing view once the debug session is complete.
				testOutputChannel.show();
				vscode.commands.executeCommand('workbench.view.testing.focus');
			}
		});
		return await vscode.debug.startDebugging(workspaceFolder, debugConfig);
	}

	return false;
}

/**
 * Process the resulting data from a target's test.xml file and convert into corresponding array of GoTestOutput events.
 * This format provides compatibility with existing methods GoTestRunner to report updated results to the UI.
 *
 * @param resultData TestResultXML object containing the parsed results from a target's test.xml output file.
 * @returns Data set with its contents converted into corresponding GoTestOutput data.
 */
export function testResultXMLToGoTestOutput(resultData: TestResultXML): GoTestOutput[] {
	const results: GoTestOutput[] = [];

	for (const suite of resultData.testsuites.testsuite) {
		const currPackage = suite.$.name;

		// Skip the suite if no data is present for any of its test cases (e.g. due to test filter).
		if (!suite.testcase) continue;

		// Convert the results of each test case into GoTestOutput.
		for (const currTestCase of suite.testcase) {
			let action = 'pass';
			const messages: string[] = [];
			if (currTestCase.failure) {
				action = 'fail';
				// Due to upstream design, messages are currently supported only for failures.
				// eslint-disable-next-line @typescript-eslint/no-explicit-any
				currTestCase.failure.forEach((entry: any) => messages.push(...entry._.split('\n')));
			} else if (currTestCase.error) {
				action = 'errored';
				// eslint-disable-next-line @typescript-eslint/no-explicit-any
				currTestCase.error.forEach((entry: any) => messages.push(...entry._.split('\n')));
			} else if (currTestCase.skipped) {
				action = 'skip';
			}

			// Each line of output becomes its own entry in results. Must be positioned before its corresponding failure entry.
			for (const message of messages) {
				results.push({
					Action: 'output',
					Output: message + '\n',
					Package: currPackage,
					Test: currTestCase.$.name
				});
			}

			// Final result must follow the output entries.
			results.push({
				Action: action,
				Package: currPackage,
				Test: currTestCase.$.name,
				Elapsed: Number(currTestCase.$.time)
			});
		}
	}

	return results;
}

/**
 * Process build events in JSON output format. Currently collects the xml paths of test result outputs.
 * Will be extended to collect additional information (e.g. build failure details) in the same pass.
 *
 * @param buildEventsFile File path to the JSON build events output.
 * @param outputChannel vscode.OutputChannel where information and errors will be displayed during processing.
 * @returns Promise that resolves to a BuildEventOutputs object.
 */

export function processBuildEvents(
	buildEventsFile: string,
	outputChannel: vscode.OutputChannel
): Promise<BuildEventOutputs> {
	return new Promise((resolve) => {
		const outputs: BuildEventOutputs = {
			testXMLPaths: [],
			errorMessages: [],
			exitCode: ExitCode.FailedToParse,
			workspaceDirectory: ''
		};
		const deleteAndResolve = () => {
			fs.unlink(buildEventsFile, () => {});
			resolve(outputs);
		};

		const updateErrorMessages = getErrorMessageCollector();
		let lineReader: readline.Interface;
		try {
			const fileStream = fs.createReadStream(buildEventsFile);
			lineReader = readline.createInterface({
				input: fileStream
			});
		} catch {
			outputChannel.appendLine(`ERROR: Unable to get data from build events file: ${buildEventsFile}`);
			return deleteAndResolve();
		}

		// --build_event_json_file stores multiple JSON strings in the same file, delimited by newlines.
		lineReader.on('line', (line) => {
			try {
				const parsed = JSON.parse(line);
				parsed.id.buildFinished && (outputs.exitCode = parsed.finished.exitCode.code || 0);
				outputs.errorMessages = updateErrorMessages(parsed.progress?.stderr);

				// Use id to determine whether this build event contains data that is needed for output.
				// This section filters to down to the correct field (which can be deeply nested), and stores the results.
				if (parsed.id.workspace) {
					// Full path to the coverage output not available in its own field, but is defined relative to bazel-out.
					// Capture localExecRoot to calculate absolute path to bazel-out.
					outputs.localExecRoot = parsed.workspaceInfo.localExecRoot;
				} else if (parsed.id.started) {
					outputs.workspaceDirectory = parsed.started.workspaceDirectory;
				} else if (parsed.id.testResult) {
					for (const testActionOutput of parsed.testResult.testActionOutput) {
						if (testActionOutput.name === 'test.xml')
							outputs.testXMLPaths.push(testActionOutput.uri.replace(/^(file:\/\/)/, ''));
					}
				} else if (parsed.id.configuration) {
					outputs.genDir = parsed.configuration.makeVariable.GENDIR;
				}
			} catch {
				// As malformed data on one line could affect the integrity of remaining results, stop processing on the first error.
				outputChannel.appendLine(
					`ERROR: Unable to finish parsing build events due to malformed JSON in ${buildEventsFile}. Test results in the UI may be incomplete.`
				);
				lineReader.close();
			}
		});

		lineReader.on('close', () => deleteAndResolve());
		lineReader.on('error', () => deleteAndResolve());
	});
}

/**
 * Iterates through a given list of test output xml files, and converts their contents to an array of GoTestEvent.
 * These are then passed into the provided goTestOutputConsumer function which handles updates to the test explorer UI.
 * @param xmlFilePaths containing the full path to test result xml outputs from this run.
 * @param outputChannel vscode.OutputChannel where information and errors will be displayed during processing.
 * @param goTestOutputConsumer function that accepts GoTestOutput and handles updates to the test explorer UI.
 */
export async function processTestResultXML(
	xmlFilePaths: string[],
	outputChannel: vscode.OutputChannel,
	goTestOutputConsumer: (_: GoTestOutput) => void
) {
	outputChannel.appendLine(
		`INFO: ${xmlFilePaths.length} test result file${xmlFilePaths.length === 1 ? '' : 's'} found.`
	);
	const parser = new xml2js.Parser();
	for (const filePath of xmlFilePaths) {
		try {
			// Open each test.xml file, parse its contents, then convert to an array of GoTestOutput results.
			const results = fs.readFileSync(filePath);
			const parsedXML = await parser.parseStringPromise(results);
			const goTestOutput = testResultXMLToGoTestOutput(parsedXML);
			for (const output of goTestOutput) goTestOutputConsumer(output);
			outputChannel.appendLine(`INFO: Completed parsing of test results from ${filePath}`);
		} catch {
			outputChannel.appendLine(`ERROR: Unable to parse test results from ${filePath}`);
		}
	}
}

/**
 * Provides a function to evaluate and collect all error messages.
 * @returns a function which accepts stderr input and keeps track of the relevant error message lines in its closure.
 */
export function getErrorMessageCollector(): Function {
	const regError = /^(ERROR:|Internal error thrown during build.)\s/m;
	const regNonErrorLog = /^(DEBUG|INFO|WARN):/;
	const regProgress = /^\[\d+ \/ \d+\]/;
	let sawError = false;
	const output: string[] = [];

	// Returns a function that accepts stderr contents and collects error messages if present.
	return (msg?: string): string[] => {
		// A call with no argument will provide the current stored error message lines.
		if (!msg) return output;

		const match = regError.exec(msg);
		const errMsg = match ? msg.slice(match?.index) : '';

		if (errMsg.length > 0) {
			output.push(errMsg);
			sawError = true;
			return output;
		} else if (sawError && !regNonErrorLog.test(msg) && !regProgress.test(msg)) {
			// previous progress message is an error and this message is not a log or progress line, it may be error messages
			// from underlying tool that Bazel calls
			output.push(msg);
		}
		sawError = false;
		return output;
	};
}
