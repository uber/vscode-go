import assert = require('assert');
import cp = require('child_process');
import fs = require('fs');
import os = require('os');
import path = require('path');
import sinon = require('sinon');
import xml2js = require('xml2js');
import {
	DebugConfiguration,
	Uri,
	workspace,
	WorkspaceConfiguration,
	TestController,
	TestRun,
	OutputChannel,
	TestItem
} from 'vscode';
import * as bazelTestUtils from '../../src/bazel/bazelTestUtils';
import * as testUtils from '../../src/testUtils';
import { forceDidOpenTextDocument } from './goTest.utils';
import { BazelGoTestExplorer } from '../../src/bazel/bazelExplore';
import { MockExtensionContext } from '../mocks/MockContext';
import { MockCfg } from '../mocks/MockCfg';
import { GoTestResolver } from '../../src/goTest/resolve';
import { GoTestRunner, TestRunOutput } from '../../src/goTest/run';
import { MockTestController } from '../mocks/MockTest';
import { BazelGoTestRunner } from '../../src/bazel/bazelRun';

// TODO:
// - Tests for bazelDebugTestAtCursor()
suite('Bazel Go Test Runner', () => {
	const fixtureDir = path.join(__dirname, '..', '..', '..', 'test', 'testdata');

	let testExplorer: BazelGoTestExplorer;

	suite('Run Tests', () => {
		const sandbox = sinon.createSandbox();
		const ctx = MockExtensionContext.new();

		let uri: Uri;

		suiteSetup(async () => {
			testExplorer = BazelGoTestExplorer.setup(ctx, {});

			uri = Uri.file(path.join(fixtureDir, 'codelens', 'codelens2_test.go'));
			await forceDidOpenTextDocument(workspace, testExplorer, uri);
		});

		teardown(() => {
			sandbox.restore();
		});

		suiteTeardown(() => {
			ctx.teardown();
		});

		test('check setup', async () => {
			assert(testExplorer.runner instanceof BazelGoTestRunner);
			assert.strictEqual(ctx.subscriptions.length, 13);
		});

		test('Run test using super class run() method', async () => {
			const ctrl = new MockTestController();
			const item = ctrl.createTestItem('sampleTest', 'sampleTestLabel', undefined);
			const goTestRunStub = sandbox.stub(GoTestRunner.prototype, 'run');
			await testExplorer.runner.run({
				include: [item],
				exclude: undefined,
				profile: undefined
			});
			assert.strictEqual(goTestRunStub.callCount, 1, 'expected one call to GoTestRunner.run');
		});

		test('Debug test using super class debug() method', async () => {
			const ctrl = new MockTestController();
			const item = ctrl.createTestItem('sampleTest', 'sampleTestLabel', undefined);
			const goTestDebugStub = sandbox.stub(GoTestRunner.prototype, 'debug');
			await testExplorer.runner.debug({
				include: [item],
				exclude: undefined,
				profile: undefined
			});
			assert.strictEqual(goTestDebugStub.callCount, 1, 'expected one call to GoTestRunner.debug');
		});

		test('Resolve tests that do not contain testify suite methods', async () => {
			const ctrl = new MockTestController();
			const test = ctrl.createTestItem('sampleTest', 'sampleTestLabel', undefined);
			const tests: Record<string, TestItem> = {
				sampleTest: test
			};

			const goTestResolveStub = sandbox.stub(GoTestRunner.prototype, 'resolveTestName');
			testExplorer.runner.resolveTestName(tests, 'sampleTest');
			assert.strictEqual(goTestResolveStub.callCount, 1);
			assert.strictEqual(goTestResolveStub.lastCall.args[0], tests);
			assert.strictEqual(goTestResolveStub.lastCall.args[1], 'sampleTest');
		});

		test('Resolve tests that contain testify suite methods', async () => {
			const ctrl = new MockTestController();
			const testSuite = ctrl.createTestItem('test#MyTestSuite', 'MyTestSuite', undefined);
			const testCase1 = ctrl.createTestItem('test#(*mySuiteType).TestCase1', 'TestCase1', undefined);
			const testCase2 = ctrl.createTestItem('test#(*mySuiteType).TestCase2', 'TestCase1', undefined);
			testExplorer.resolver.isTestSuiteFunc.add(testSuite);
			testSuite.children.add(testCase1);
			testSuite.children.add(testCase2);

			// Test run initiated by clicking on an individual test case.
			let tests: Record<string, TestItem> = {
				'(*mySuiteType).TestCase1': testCase1
			};
			let resultItem = testExplorer.runner.resolveTestName(tests, 'MyTestSuite/TestCase1');
			assert.strictEqual(resultItem, testCase1);

			// Test run initiated by clicking on the suite.
			tests = {
				MyTestSuite: testSuite
			};

			resultItem = testExplorer.runner.resolveTestName(tests, 'MyTestSuite/TestCase1');
			assert.strictEqual(resultItem, testCase1);

			// Generate correct test filter formatting for suite methods.
			let resultString = (testExplorer.runner as BazelGoTestRunner).formatTestCaseForFilter(
				'(*mySuiteType).TestCase2',
				testCase2
			);
			assert.strictEqual(resultString, 'MyTestSuite/TestCase2');

			resultString = (testExplorer.runner as BazelGoTestRunner).formatTestCaseForFilter('MyTestSuite', testSuite);
			assert.strictEqual(resultString, 'MyTestSuite');
		});

		test('Resolve subtests within test suite methods', async () => {
			const getOrCreateSubTestStub = sandbox.stub(GoTestResolver.prototype, 'getOrCreateSubTest');
			const ctrl = new MockTestController();
			const testSuite = ctrl.createTestItem(
				'file:///path/to/mod/file.go?test#MyTestSuite',
				'MyTestSuite',
				Uri.parse('file:///path/to/mod/file.go?test#MyTestSuite')
			);
			const testCase1 = ctrl.createTestItem(
				'file:///path/to/mod/file.go?test#(*mySuiteType).TestCase1',
				'TestCase1',
				Uri.parse('file:///path/to/mod/file.go?test#TestCase1')
			);

			testExplorer.resolver.isTestSuiteFunc.add(testSuite);
			testSuite.children.add(testCase1);

			// Test run initiated by clicking on an individual test case.
			const tests: Record<string, TestItem> = {
				'(*mySuiteType).TestCase1': testCase1
			};

			testExplorer.runner.resolveTestName(tests, 'MyTestSuite/TestCase1/SubTest1');
			assert(
				getOrCreateSubTestStub.calledOnceWith(
					testCase1,
					'MyTestSuite/TestCase1/SubTest1',
					'MyTestSuite/TestCase1/SubTest1',
					true
				)
			);
		});
	});
});

suite('Bazel Test Utils', () => {
	let mockDebugConfig: DebugConfiguration;
	let mockTestConfig: testUtils.TestConfig;
	let mockCfg: WorkspaceConfiguration;

	suiteSetup(async () => {
		mockDebugConfig = {
			name: 'Bazel Debug Sample',
			type: 'go',
			request: 'attach',
			port: 9876,
			host: '127.0.0.1'
		};

		mockCfg = new MockCfg();

		mockTestConfig = {
			dir: 'fakedir/',
			goConfig: mockCfg,
			flags: []
		};
	});

	suite('goTestWithBazel command execution', () => {
		// This suite will confirm that the correct Bazel command gets passed to cp.exec given a set of arguments.
		// Since it won't actually execute, assertions will only confirm that the correct arguments are passed.

		let mockCtrl: MockTestController;
		let mockRun: TestRun;
		let outputChannel: TestRunOutput;

		let sandbox: sinon.SinonSandbox;
		let execStub: sinon.SinonStub;

		suiteSetup(async () => {
			mockCtrl = new MockTestController();
			mockRun = mockCtrl.createTestRun({ include: [], exclude: [], profile: undefined }, 'Mock Test Run');

			sandbox = sinon.createSandbox();
			execStub = sandbox.stub(cp, 'exec');

			const processBuildEventsStub = sandbox.stub(bazelTestUtils, 'processBuildEvents');
			processBuildEventsStub.callsFake(
				// eslint-disable-next-line @typescript-eslint/no-unused-vars
				(buildEventsFile: string, outputChannel: OutputChannel): Promise<bazelTestUtils.BuildEventOutputs> => {
					return new Promise<bazelTestUtils.BuildEventOutputs>((resolve) =>
						resolve({
							testXMLPaths: [],
							errorMessages: [],
							exitCode: -1,
							workspaceDirectory: '/sample-code'
						})
					);
				}
			);
		});

		test('Bazel test command generated', async () => {
			outputChannel = new TestRunOutput(mockRun);
			mockTestConfig = {
				dir: 'fakedir/',
				goConfig: mockCfg,
				flags: [],
				functions: ['TestFunc1', 'TestFunc2'],
				outputChannel: outputChannel
			};
			await bazelTestUtils.goTestWithBazel(mockTestConfig);
			// --build_event_json_file= will vary each time, so confirm that the portion before this is correct.
			// More detailed checking of the Bazel arguments occurs during the "Get Bazel Args from Packages" suite.
			assert.strictEqual(
				outputChannel.lines[0].split(' --build_event_json_file=')[0],
				'Running command: bazel test --build_tests_only --test_env=GO_TEST_WRAP_TESTV=1'
			);
			assert.strictEqual(
				execStub.lastCall.args[0].split(' --build_event_json_file=')[0],
				'bazel test --build_tests_only --test_env=GO_TEST_WRAP_TESTV=1'
			);
		});

		test('Bazel debug command generated', async () => {
			outputChannel = new TestRunOutput(mockRun);
			mockTestConfig = {
				dir: 'fakedir/',
				goConfig: mockCfg,
				flags: [],
				functions: ['TestFunc1', 'TestFunc2'],
				outputChannel: outputChannel
			};

			await bazelTestUtils.goTestWithBazel(mockTestConfig, mockDebugConfig);
			assert.strictEqual(
				outputChannel.lines[0].split(' --build_event_json_file=')[0],
				'Running command: bazel debug --port=9876 --tool_tag=vscode-go-bazel'
			);
			assert.strictEqual(
				execStub.lastCall.args[0].split(' --build_event_json_file=')[0],
				'bazel debug --port=9876 --tool_tag=vscode-go-bazel'
			);
		});

		test('Bazel coverage command generated', async () => {
			outputChannel = new TestRunOutput(mockRun);
			mockTestConfig = {
				dir: 'fakedir/',
				goConfig: mockCfg,
				flags: [],
				functions: ['TestFunc1', 'TestFunc2'],
				outputChannel: outputChannel,
				applyCodeCoverage: true
			};

			await bazelTestUtils.goTestWithBazel(mockTestConfig);
			assert.strictEqual(
				outputChannel.lines[0].split(' --build_event_json_file=')[0],
				'Running command: bazel coverage --combined_report=lcov --@io_bazel_rules_go//go/config:cover_format=lcov --build_tests_only --test_env=GO_TEST_WRAP_TESTV=1'
			);
			assert.strictEqual(
				execStub.lastCall.args[0].split(' --build_event_json_file=')[0],
				'bazel coverage --combined_report=lcov --@io_bazel_rules_go//go/config:cover_format=lcov --build_tests_only --test_env=GO_TEST_WRAP_TESTV=1'
			);
		});

		test('Bazel benchmark command generated', async () => {
			outputChannel = new TestRunOutput(mockRun);
			mockTestConfig = {
				dir: 'fakedir/',
				goConfig: mockCfg,
				flags: [],
				functions: ['BenchmarkFunc1'],
				outputChannel: outputChannel,
				isBenchmark: true
			};

			await bazelTestUtils.goTestWithBazel(mockTestConfig);
			assert.strictEqual(
				outputChannel.lines[0].split(' --build_event_json_file=')[0],
				'Running command: bazel run --build_tests_only --test_env=GO_TEST_WRAP_TESTV=1'
			);
			assert(outputChannel.lines[0].endsWith('-- -test.bench=.'));

			assert.strictEqual(
				execStub.lastCall.args[0].split(' --build_event_json_file=')[0],
				'bazel run --build_tests_only --test_env=GO_TEST_WRAP_TESTV=1'
			);
			assert(execStub.lastCall.args[0].endsWith('-- -test.bench=.'));
		});

		suiteTeardown(() => {
			sandbox.restore();
		});
	});

	suite('Get Bazel Targets from Packages', () => {
		test('Returns test target names from a list of packages', async () => {
			const packages = ['path/to/package1', 'path/to/package2'];
			const targets = await bazelTestUtils.getBazelTargetsFromPackages(mockTestConfig, packages, '/src');
			assert.strictEqual(targets[0], 'path/to/package1:all', 'Incorrectly formatted target');
			assert.strictEqual(targets[1], 'path/to/package2:all', 'Incorrectly formatted target');
			assert.strictEqual(targets.length, packages.length, 'Incorrect number of targets returned');
		});

		test('Returns test target names from a list of packages (for debugging)', async () => {
			const packages = ['path/to/package1', 'path/to/package2'];
			const targets = await bazelTestUtils.getBazelTargetsFromPackages(
				mockTestConfig,
				packages,
				'/src',
				mockDebugConfig
			);
			assert.strictEqual(targets[0], 'path/to/package1:go_default_test', 'Incorrectly formatted target');
			assert.strictEqual(targets[1], 'path/to/package2:go_default_test', 'Incorrectly formatted target');
			assert.strictEqual(targets.length, packages.length, 'Incorrect number of targets returned');
		});
	});

	suite('Get Bazel Test Environment Variables', () => {
		let mockCfg: WorkspaceConfiguration;

		const PROJECT_ROOT = path.normalize(path.join(__dirname, '..', '..', '..'));
		const DATA_ROOT = path.join(PROJECT_ROOT, 'test', 'testdata', 'bazelEnvTest');
		const ENV_FILE = path.join(DATA_ROOT, 'bazelSettings.env');
		test('Returns variables from go.toolsEnvVars', async () => {
			mockCfg = new MockCfg({
				testEnvVars: {
					AAA: '111',
					BBB: '222',
					CCC: '333',
					DDD: '444'
				}
			});
			const envVars = bazelTestUtils.getBazelTestEnvVars(mockCfg);
			assert.strictEqual(envVars.includes('--test_env=AAA=111'), true);
			assert.strictEqual(envVars.includes('--test_env=BBB=222'), true);
			assert.strictEqual(envVars.includes('--test_env=CCC=333'), true);
			assert.strictEqual(envVars.includes('--test_env=DDD=444'), true);
		});

		test('Returns variables from environment variables file', async () => {
			mockCfg = new MockCfg({
				testEnvFile: ENV_FILE
			});
			const envVars = bazelTestUtils.getBazelTestEnvVars(mockCfg);
			assert.strictEqual(envVars.includes('--test_env=CCC=333'), true);
			assert.strictEqual(envVars.includes('--test_env=DDD=444'), true);
			assert.strictEqual(envVars.includes('--test_env=EEE=555'), true);
			assert.strictEqual(envVars.includes('--test_env=FFF=666'), true);
		});

		test('returns values with precedence for user defined variables', async () => {
			mockCfg = new MockCfg({
				testEnvFile: ENV_FILE,
				testEnvVars: {
					AAA: '000',
					BBB: '111',
					CCC: '222',
					DDD: '333'
				}
			});
			const envVars = bazelTestUtils.getBazelTestEnvVars(mockCfg);
			assert.strictEqual(envVars.includes('--test_env=AAA=000'), true);
			assert.strictEqual(envVars.includes('--test_env=BBB=111'), true);
			assert.strictEqual(envVars.includes('--test_env=CCC=222'), true);
			assert.strictEqual(envVars.includes('--test_env=DDD=333'), true);
			assert.strictEqual(envVars.includes('--test_env=EEE=555'), true);
			assert.strictEqual(envVars.includes('--test_env=FFF=666'), true);
		});
	});

	suite('Get Bazel Args from Packages', () => {
		let mockCfg: WorkspaceConfiguration;
		let filePath: string;

		suiteSetup(async () => {
			mockCfg = new MockCfg();
			filePath = path.join(os.tmpdir(), 'sample_output_file');
		});

		test('Returns correct set of arguments to run one test case', async () => {
			const args = bazelTestUtils.getBazelArgs(
				{
					dir: '/',
					goConfig: mockCfg,
					functions: ['func1'],
					flags: ['--user_sample_flag=TRUE', '--other_user_flag=FALSE']
				},
				['path/to/target:go_default_test'],
				filePath
			);
			const runArgs = [
				'test',
				'--build_tests_only',
				'--test_env=GO_TEST_WRAP_TESTV=1',
				`--build_event_json_file=${filePath}`,
				'--build_event_json_file_path_conversion=no',
				'--tool_tag=vscode-go-bazel',
				"--test_filter='^func1$'",
				'--user_sample_flag=TRUE',
				'--other_user_flag=FALSE'
			];
			runArgs.forEach((val, i) => assert.strictEqual(args[i], val), 'Argument mismatch');
		});

		test('Returns correct set of arguments to multiple test cases', async () => {
			const args = bazelTestUtils.getBazelArgs(
				{
					dir: '/',
					goConfig: mockCfg,
					functions: ['func1', 'func2', 'func3'],
					flags: ['--user_sample_flag=TRUE', '--other_user_flag=FALSE']
				},
				['path/to/target:go_default_test'],
				filePath
			);
			const runArgs = [
				'test',
				'--build_tests_only',
				'--test_env=GO_TEST_WRAP_TESTV=1',
				`--build_event_json_file=${filePath}`,
				'--build_event_json_file_path_conversion=no',
				'--tool_tag=vscode-go-bazel',
				"--test_filter='^(func1|func2|func3)$'",
				'--user_sample_flag=TRUE',
				'--other_user_flag=FALSE'
			];
			runArgs.forEach((val, i) => assert.strictEqual(args[i], val), 'Argument mismatch');
		});

		test('Returns correct set of arguments to run one test case (with coverage)', async () => {
			const args = bazelTestUtils.getBazelArgs(
				{
					dir: '/',
					goConfig: mockCfg,
					functions: ['func1'],
					flags: ['--user_sample_flag=TRUE', '--other_user_flag=FALSE'],
					applyCodeCoverage: true
				},
				['path/to/target:go_default_test'],
				filePath
			);
			const runArgs = [
				'coverage',
				'--combined_report=lcov',
				'--@io_bazel_rules_go//go/config:cover_format=lcov',
				'--build_tests_only',
				'--test_env=GO_TEST_WRAP_TESTV=1',
				`--build_event_json_file=${filePath}`,
				'--build_event_json_file_path_conversion=no',
				'--tool_tag=vscode-go-bazel',
				"--test_filter='^func1$'",
				'--user_sample_flag=TRUE',
				'--other_user_flag=FALSE'
			];
			runArgs.forEach((val, i) => assert.strictEqual(args[i], val), 'Argument mismatch');
		});

		test('Returns correct set of arguments to multiple test cases (with coverage)', async () => {
			const args = bazelTestUtils.getBazelArgs(
				{
					dir: '/',
					goConfig: mockCfg,
					functions: ['func1', 'func2', 'func3'],
					flags: ['--user_sample_flag=TRUE', '--other_user_flag=FALSE'],
					applyCodeCoverage: true
				},
				['path/to/target:go_default_test'],
				filePath
			);
			const runArgs = [
				'coverage',
				'--combined_report=lcov',
				'--@io_bazel_rules_go//go/config:cover_format=lcov',
				'--build_tests_only',
				'--test_env=GO_TEST_WRAP_TESTV=1',
				`--build_event_json_file=${filePath}`,
				'--build_event_json_file_path_conversion=no',
				'--tool_tag=vscode-go-bazel',
				"--test_filter='^(func1|func2|func3)$'",
				'--user_sample_flag=TRUE',
				'--other_user_flag=FALSE'
			];
			runArgs.forEach((val, i) => assert.strictEqual(args[i], val), 'Argument mismatch');
		});

		test('Returns correct set of arguments to run one benchmark', async () => {
			const args = bazelTestUtils.getBazelArgs(
				{
					dir: '/',
					goConfig: mockCfg,
					functions: ['BenchmarkFunc1'],
					flags: ['--user_sample_flag=TRUE', '--other_user_flag=FALSE'],
					isBenchmark: true
				},
				['path/to/target:go_default_test'],
				filePath
			);
			const runArgs = [
				'run',
				'--build_tests_only',
				'--test_env=GO_TEST_WRAP_TESTV=1',
				`--build_event_json_file=${filePath}`,
				'--build_event_json_file_path_conversion=no',
				'--tool_tag=vscode-go-bazel',
				"--test_filter='^BenchmarkFunc1$'",
				'--user_sample_flag=TRUE',
				'--other_user_flag=FALSE'
			];
			runArgs.forEach((val, i) => assert.strictEqual(args[i], val), 'Argument mismatch');
			assert.strictEqual(args[args.length - 1], '-- -test.bench=.');
		});

		test('Returns correct set of arguments to multiple benchmarks', async () => {
			const args = bazelTestUtils.getBazelArgs(
				{
					dir: '/',
					goConfig: mockCfg,
					functions: ['BenchmarkFunc1', 'BenchmarkFunc2', 'BenchmarkFunc3'],
					flags: ['--user_sample_flag=TRUE', '--other_user_flag=FALSE'],
					isBenchmark: true
				},
				['path/to/target:go_default_test'],
				filePath
			);
			const runArgs = [
				'run',
				'--build_tests_only',
				'--test_env=GO_TEST_WRAP_TESTV=1',
				`--build_event_json_file=${filePath}`,
				'--build_event_json_file_path_conversion=no',
				'--tool_tag=vscode-go-bazel',
				"--test_filter='^(BenchmarkFunc1|BenchmarkFunc2|BenchmarkFunc3)$'",
				'--user_sample_flag=TRUE',
				'--other_user_flag=FALSE'
			];
			runArgs.forEach((val, i) => assert.strictEqual(args[i], val), 'Argument mismatch');
			assert.strictEqual(args[args.length - 1], '-- -test.bench=.');
		});

		test('Returns correct set of arguments to run subtests (with special characters)', async () => {
			const args = bazelTestUtils.getBazelArgs(
				{
					dir: '/',
					goConfig: mockCfg,
					functions: ['func1/subtest$(001)', 'func1/test:with.separators', 'func1/test[01]'],
					flags: ['--user_sample_flag=TRUE', '--other_user_flag=FALSE']
				},
				['path/to/target:go_default_test'],
				filePath
			);
			const runArgs = [
				'test',
				'--build_tests_only',
				'--test_env=GO_TEST_WRAP_TESTV=1',
				`--build_event_json_file=${filePath}`,
				'--build_event_json_file_path_conversion=no',
				'--tool_tag=vscode-go-bazel',
				"--test_filter='^(func1$/^subtest\\$\\(001\\)|func1$/^test:with\\.separators|func1$/^test\\[01\\])$'",
				'--user_sample_flag=TRUE',
				'--other_user_flag=FALSE'
			];
			runArgs.forEach((val, i) => assert.strictEqual(args[i], val), 'Argument mismatch');
		});

		test('Returns correct set of arguments to debug test', async () => {
			const args = bazelTestUtils.getBazelArgs(
				{ dir: '/', goConfig: mockCfg, functions: ['func1'], flags: ['--user_sample_flag=TRUE'] },
				['path/to/target:go_default_test'],
				'/sample/filename',
				mockDebugConfig
			);
			const debugArgs = [
				'debug',
				'--port=9876',
				'--tool_tag=vscode-go-bazel',
				"--test_filter='^func1$'",
				'--user_sample_flag=TRUE'
			];
			debugArgs.forEach((val, i) => assert.strictEqual(args[i], val), 'Argument mismatch');
		});
	});

	suite('Convert XML Output to GoTestOutput[]', () => {
		const sampleData: { [key: string]: bazelTestUtils.TestResultXML } = {};
		suiteSetup(async () => {
			const PROJECT_ROOT = path.normalize(path.join(__dirname, '..', '..', '..'));
			const DATA_ROOT = path.join(PROJECT_ROOT, 'test', 'testdata', 'xmlTestOutput');

			const parser = new xml2js.Parser();
			const dataFiles = [
				'test_0_testcase.xml',
				'test_1_testcase_0_fail.xml',
				'test_many_testcase_1_fail_1_skip.xml',
				'test_runtime_error.xml',
				'test_1_fail_with_logs.xml'
			];
			for (const fileName of dataFiles) {
				const results = fs.readFileSync(path.join(DATA_ROOT, fileName));
				await parser.parseString(results, (err: Error | null, resultData: bazelTestUtils.TestResultXML) => {
					sampleData[fileName] = resultData;
				});
			}
		});

		test('Return empty array when no test cases have been run', async () => {
			const goTestOutput = bazelTestUtils.testResultXMLToGoTestOutput(sampleData['test_0_testcase.xml']);
			assert.strictEqual(goTestOutput.length, 0);
		});

		test('Return 1 result when there is 1 passed test', async () => {
			const goTestOutput = bazelTestUtils.testResultXMLToGoTestOutput(sampleData['test_1_testcase_0_fail.xml']);
			assert.strictEqual(goTestOutput.length, 1);
			assert.strictEqual(goTestOutput[0].Action, 'pass');
			assert.strictEqual(goTestOutput[0].Elapsed, 10);
			assert.strictEqual(goTestOutput[0].Output, undefined);
			assert.strictEqual(goTestOutput[0].Package, 'code/sample/fakepackage');
			assert.strictEqual(goTestOutput[0].Test, 'FakeTestCase');
		});

		test('Correctly process a data set with many test cases', () => {
			const goTestOutput = bazelTestUtils.testResultXMLToGoTestOutput(
				sampleData['test_many_testcase_1_fail_1_skip.xml']
			);
			assert.strictEqual(goTestOutput.length, 94);

			// This data set contains 1 failed and 1 skipped test case.
			const failIndex = goTestOutput.findIndex((value) => value.Action === 'fail');
			const skipIndex = goTestOutput.findIndex((value) => value.Action === 'skip');

			// Failed test contains correct required fields
			assert.strictEqual(goTestOutput[failIndex].Action, 'fail');
			assert.strictEqual(goTestOutput[failIndex].Elapsed, 26.5);
			assert.strictEqual(goTestOutput[failIndex].Output, undefined);
			assert.strictEqual(goTestOutput[failIndex].Package, 'code/sample/fakepackage');
			assert.strictEqual(goTestOutput[failIndex].Test, 'FakeFailedTestCase');

			// Array contains entries for the failed test output, positioned immediately before the failure message
			let i = failIndex - 2;
			const messageSegments = ['Message line 1\n', 'Message line 2\n'];
			for (const segment of messageSegments) {
				assert.strictEqual(goTestOutput[i].Action, 'output');
				assert.strictEqual(goTestOutput[i].Elapsed, undefined);
				assert.strictEqual(goTestOutput[i].Package, 'code/sample/fakepackage');
				assert.strictEqual(goTestOutput[i].Test, 'FakeFailedTestCase');
				assert.strictEqual(goTestOutput[i].Output, segment);
				i++;
			}

			// Skipped test contains correct required fields
			assert.strictEqual(goTestOutput[skipIndex].Action, 'skip');
			assert.strictEqual(goTestOutput[skipIndex].Elapsed, 0);
			assert.strictEqual(goTestOutput[skipIndex].Output, undefined);
			assert.strictEqual(goTestOutput[skipIndex].Package, 'code/sample/fakepackage');
			assert.strictEqual(goTestOutput[skipIndex].Test, 'FakeSkippedTestCase');
		});

		test('Correctly processes a test case with a runtime error', async () => {
			const goTestOutput = bazelTestUtils.testResultXMLToGoTestOutput(sampleData['test_runtime_error.xml']);

			// This data set contains 1 runtime error result
			const erroredIndex = goTestOutput.findIndex((value) => value.Action === 'errored');

			assert.strictEqual(goTestOutput.length, 22);
			assert.strictEqual(goTestOutput[erroredIndex].Action, 'errored');
			assert.strictEqual(goTestOutput[erroredIndex].Elapsed, 0);
			assert.strictEqual(goTestOutput[erroredIndex].Output, undefined);
			assert.strictEqual(goTestOutput[erroredIndex].Package, 'code/sample/fakepackage');
			assert.strictEqual(goTestOutput[erroredIndex].Test, 'ErrorTestCase');

			// Array contains entries for the errored test output, positioned immediately before the error message
			let i = erroredIndex - 2;
			const messageSegments = ['Message line 1\n', 'Message line 2\n'];
			for (const segment of messageSegments) {
				assert.strictEqual(goTestOutput[i].Action, 'output');
				assert.strictEqual(goTestOutput[i].Elapsed, undefined);
				assert.strictEqual(goTestOutput[i].Package, 'code/sample/fakepackage');
				assert.strictEqual(goTestOutput[i].Test, 'ErrorTestCase');
				assert.strictEqual(goTestOutput[i].Output, segment);
				i++;
			}
		});

		test('Correctly process a data set where there are log messages among the test output', () => {
			const goTestOutput = bazelTestUtils.testResultXMLToGoTestOutput(sampleData['test_1_fail_with_logs.xml']);
			assert.strictEqual(goTestOutput.length, 5);

			// This data set contains 1 failed test case.
			const failIndex = goTestOutput.findIndex((value) => value.Action === 'fail');

			// Failed test contains correct required fields
			assert.strictEqual(goTestOutput[failIndex].Action, 'fail');
			assert.strictEqual(goTestOutput[failIndex].Elapsed, 0.33);
			assert.strictEqual(goTestOutput[failIndex].Output, undefined);
			assert.strictEqual(
				goTestOutput[failIndex].Package,
				'src/code/project/example/component_tests/go_default_test'
			);
			assert.strictEqual(goTestOutput[failIndex].Test, 'TestExampleCase');

			// Array contains entries for the failed test output, positioned immediately before the failure message
			let i = failIndex - 2;
			const messageSegments = ['--- FAIL: TestExampleCase (0.33s)\n', '\n'];
			for (const segment of messageSegments) {
				assert.strictEqual(goTestOutput[i].Action, 'output');
				assert.strictEqual(goTestOutput[i].Elapsed, undefined);
				assert.strictEqual(goTestOutput[i].Package, 'src/code/project/example/component_tests/go_default_test');
				assert.strictEqual(goTestOutput[i].Test, 'TestExampleCase');
				assert.strictEqual(goTestOutput[i].Output, segment);
				i++;
			}
		});
	});

	suite('Loads events from XML file and passes correct data to goTestOutputConsumer', () => {
		const paths: string[] = [];
		let mockCtrl: TestController;
		let mockRun: TestRun;

		suiteSetup(async () => {
			const PROJECT_ROOT = path.normalize(path.join(__dirname, '..', '..', '..'));
			const DATA_ROOT = path.join(PROJECT_ROOT, 'test', 'testdata', 'xmlTestOutput');
			const dataFiles = [
				'test_0_testcase.xml',
				'test_1_testcase_0_fail.xml',
				'test_many_testcase_1_fail_1_skip.xml',
				'test_runtime_error.xml'
			];
			mockCtrl = new MockTestController();
			mockRun = mockCtrl.createTestRun({ include: [], exclude: [], profile: undefined }, 'Mock Test Run');

			for (const file of dataFiles) paths.push(path.join(DATA_ROOT, file));
		});

		test('Return empty array when no test cases have been run', async () => {
			const outputChannel = new TestRunOutput(mockRun);
			const results: testUtils.GoTestOutput[] = [];
			const goTestOutputMockConsumer = (output: testUtils.GoTestOutput) => results.push(output);

			await bazelTestUtils.processTestResultXML([paths[0]], outputChannel, goTestOutputMockConsumer);
			assert.strictEqual(results.length, 0);
			assert(
				outputChannel.lines.some(
					(x: string) => x === 'INFO: Completed parsing of test results from ' + paths[0]
				),
				'Does not include expected output'
			);
		});

		test('Handle 1 test case result that passes', async () => {
			const outputChannel = new TestRunOutput(mockRun);
			const results: testUtils.GoTestOutput[] = [];
			const goTestOutputMockConsumer = (output: testUtils.GoTestOutput) => results.push(output);
			await bazelTestUtils.processTestResultXML([paths[1]], outputChannel, goTestOutputMockConsumer);
			assert.strictEqual(results.length, 1);
			assert.deepStrictEqual(results, [
				{ Action: 'pass', Elapsed: 10, Package: 'code/sample/fakepackage', Test: 'FakeTestCase' }
			]);
			assert(
				outputChannel.lines.some(
					(x: string) => x === 'INFO: Completed parsing of test results from ' + paths[1]
				),
				'Does not include expected output'
			);
		});

		test('Handle many test case results', async () => {
			const outputChannel = new TestRunOutput(mockRun);
			const results: testUtils.GoTestOutput[] = [];
			const goTestOutputMockConsumer = (output: testUtils.GoTestOutput) => results.push(output);
			await bazelTestUtils.processTestResultXML([paths[2]], outputChannel, goTestOutputMockConsumer);
			assert.strictEqual(results.length, 94);
			// Testing for specific contents and positioning are covered by Convert XML Output to GoTestOutput[]
			assert(
				outputChannel.lines.some(
					(x: string) => x === 'INFO: Completed parsing of test results from ' + paths[2]
				),
				'Does not include expected output'
			);
		});

		test('Handle multiple xml files', async () => {
			const outputChannel = new TestRunOutput(mockRun);
			const results: testUtils.GoTestOutput[] = [];
			const goTestOutputMockConsumer = (output: testUtils.GoTestOutput) => results.push(output);
			await bazelTestUtils.processTestResultXML([paths[1], paths[2]], outputChannel, goTestOutputMockConsumer);
			assert.strictEqual(results.length, 95);
			// Testing for specific contents and positioning are covered by Convert XML Output to GoTestOutput[]
			for (const path of [paths[1], paths[2]]) {
				assert(
					outputChannel.lines.some(
						(x: string) => x === 'INFO: Completed parsing of test results from ' + path
					),
					'Does not include expected output'
				);
			}
		});
	});

	suite('Parse Build Event JSON Data', () => {
		let mockCtrl: TestController;
		let mockRun: TestRun;
		let DATA_ROOT: string;

		suiteSetup(async () => {
			const PROJECT_ROOT = path.normalize(path.join(__dirname, '..', '..', '..'));
			DATA_ROOT = path.join(PROJECT_ROOT, 'test', 'testdata', 'buildEventJSON');

			// Copy the test data to a temp directory as it will be deleted when the function runs.
			const dataFiles = ['build_events_valid_output', 'build_events_build_error', 'build_events_json_error'];
			for (const fileName of dataFiles) {
				fs.copyFileSync(path.join(DATA_ROOT, fileName), path.join('//tmp/', fileName));
			}

			mockCfg = new MockCfg();
			mockCtrl = new MockTestController();
			mockRun = mockCtrl.createTestRun({ include: [], exclude: [], profile: undefined }, 'Mock Test Run');
		});

		test('Valid build events file containing an xml file path', async () => {
			const outputChannel = new TestRunOutput(mockRun);
			const result = await bazelTestUtils.processBuildEvents(
				path.join('//tmp/', 'build_events_valid_output'),
				outputChannel
			);
			assert.strictEqual(result.testXMLPaths.length, 1);
			assert.strictEqual(
				result.testXMLPaths[0],
				'/home/user/.cache/bazel/_bazel_username/b97476d719d716accead0f2d5b93104f/execroot/__main__/bazel-out/k8-fastbuild/testlogs/src/project/go_default_test/test.xml'
			);
			assert.strictEqual(result.errorMessages.length, 0);
			assert.strictEqual(result.exitCode, 0);
			assert.strictEqual(
				result.localExecRoot,
				'/home/user/.cache/bazel/_bazel_username/b97476d719d716accead0f2d5b93104f/execroot/__main__'
			);
			assert.strictEqual(result.workspaceDirectory, '/home/user/sample-code');
			assert.strictEqual(result.genDir, 'bazel-out/k8-fastbuild/bin');
		});

		test('Valid build events file with build failure', async () => {
			const outputChannel = new TestRunOutput(mockRun);
			const result = await bazelTestUtils.processBuildEvents(
				path.join('//tmp/', 'build_events_build_error'),
				outputChannel
			);
			assert.strictEqual(result.testXMLPaths.length, 0);
			assert.strictEqual(result.errorMessages.length, 2);
			assert.strictEqual(result.errorMessages[0], 'ERROR: sample error message\n');
			assert.strictEqual(result.exitCode, 1);
			// Exec root won't get set as no execution occurs during a build error.
			assert.strictEqual(result.localExecRoot, undefined);
			assert.strictEqual(result.workspaceDirectory, '/home/user/sample-code');
			assert.strictEqual(result.genDir, undefined);
		});

		test('Build events file with malformed json', async () => {
			const outputChannel = new TestRunOutput(mockRun);
			const result = await bazelTestUtils.processBuildEvents(
				path.join('//tmp/', 'build_events_json_error'),
				outputChannel
			);
			assert.strictEqual(result.testXMLPaths.length, 0);
			assert(
				outputChannel.lines.some((x: string) =>
					x.startsWith('ERROR: Unable to finish parsing build events due to malformed JSON')
				),
				'Does not include expected error message'
			);
			assert.strictEqual(result.genDir, undefined);
		});
	});

	suite('Process build failure messages', () => {
		const sampleMessages: string[] = [];
		suiteSetup(() => {
			sampleMessages[0] =
				"INFO: Writing tracer profile to '/tmp/bazel_20221209162904_xpcn9'\nINFO: Invocation ID: 91dba82a-0385-4cfc-a507-2e845cde947b\nLoading: \nLoading: 0 packages loaded\nERROR: /home/user/sample-code/src/code/project/example/package/BUILD.bazel:10:9: syntax error at '//': expected expression\nERROR: error loading package 'src/code/project/example/package': Package 'src/code/project/example/package' contains errors\nINFO: Elapsed time: 0.227s\nINFO: 0 processes.\nFAILED: Build did NOT complete successfully (0 packages loaded)\nERROR: Couldn't start the build. Unable to run tests\n";
			sampleMessages[1] =
				"INFO: Writing tracer profile to '/tmp/bazel_20221209163148_y496x'\nINFO: Invocation ID: ee8f69c6-a14c-40e9-a88f-9ff5530cc54d\nLoading: \nLoading: 0 packages loaded\n";
			sampleMessages[2] =
				'Analyzing: target //src/code/project/example/package:go_default_test (1 packages loaded, 0 targets configured)\nINFO: Analyzed target //src/code/project/example/package:go_default_test (1 packages loaded, 260 targets configured).\nINFO: Found 1 test target...\n[0 / 2] [Prepa] BazelWorkspaceStatusAction stable-status.txt\n';
			sampleMessages[4] =
				'INFO: From Testing //src/code/project/example/package:go_default_test:\nTarget //src/code/project/example/package:go_default_test up-to-date:\n  bazel-bin/src/code/project/example/package/go_default_test_/go_default_test\nINFO: Elapsed time: 1.017s, Critical Path: 0.49s\nINFO: 7 processes: 1 internal, 6 processwrapper-sandbox.\nINFO: Build completed successfully, 7 total actions\n';
			sampleMessages[5] = 'sample additional error details';
		});

		test('Non error messages are ignored', () => {
			const updateErrorMessages = bazelTestUtils.getErrorMessageCollector();

			assert.strictEqual(updateErrorMessages().length, 0);
			assert.strictEqual(updateErrorMessages(sampleMessages[1]).length, 0);
			assert.strictEqual(updateErrorMessages(sampleMessages[2]).length, 0);
			assert.strictEqual(updateErrorMessages(sampleMessages[3]).length, 0);
		});

		test('Single error message', () => {
			const updateErrorMessages = bazelTestUtils.getErrorMessageCollector();

			assert.strictEqual(updateErrorMessages().length, 0);
			assert.strictEqual(updateErrorMessages(sampleMessages[1]).length, 0);
			const output = updateErrorMessages(sampleMessages[0]);
			assert.strictEqual(output.length, 1);
			assert(sampleMessages[0].endsWith(output[0]));
		});

		test('Error message followed by additional info', () => {
			const updateErrorMessages = bazelTestUtils.getErrorMessageCollector();

			assert.strictEqual(updateErrorMessages().length, 0);
			assert.strictEqual(updateErrorMessages(sampleMessages[1]).length, 0);
			updateErrorMessages(sampleMessages[0]);
			const output = updateErrorMessages(sampleMessages[5]);
			assert.strictEqual(output.length, 2);
			assert(sampleMessages[0].endsWith(output[0]));
			assert(sampleMessages[5] === output[1]);
		});
	});
});
