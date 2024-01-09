/*---------------------------------------------------------
 * Copyright 2021 The Go Authors. All rights reserved.
 * Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------*/
import assert = require('assert');
import vscode = require('vscode');
import { TestItem, Uri } from 'vscode';
import { GoTestResolver } from '../../src/goTest/resolve';
import { GoTest, GoTestKind } from '../../src/goTest/utils';
import { MockTestController, MockTestWorkspace } from '../mocks/MockTest';
import { getSymbols_Regex, populateModulePathCache } from './goTest.utils';

type Files = Record<string, string | { contents: string; language: string }>;

interface TestCase {
	workspace: string[];
	files: Files;
}

function setup(folders: string[], files: Files) {
	const workspace = MockTestWorkspace.from(folders, files);
	const ctrl = new MockTestController();
	const resolver = new GoTestResolver(workspace, ctrl, getSymbols_Regex);
	populateModulePathCache(workspace);
	return { resolver, ctrl };
}

suite('Go Test Resolver', () => {
	interface TC extends TestCase {
		item?: ([string, string, GoTestKind] | [string, string, GoTestKind, string])[];
		expect: string[];
		expectPartial?: string[];
	}

	const cases: Record<string, Record<string, TC>> = {
		Root: {
			'Basic module': {
				workspace: ['/src/proj'],
				files: {
					'/src/proj/go.mod': 'module test',
					'/src/proj/main.go': 'package main'
				},
				expect: ['file:///src/proj?module']
			},
			'Module with leading comments': {
				workspace: ['/src/proj'],
				files: {
					'/src/proj/go.mod': '// Example comment\nmodule test',
					'/src/proj/main.go': 'package main'
				},
				expect: ['file:///src/proj?module']
			},
			'Basic workspace': {
				workspace: ['/src/proj'],
				files: {
					'/src/proj/main.go': 'package main'
				},
				expect: ['file:///src/proj?workspace']
			},
			'Module and workspace': {
				workspace: ['/src/proj1', '/src/proj2'],
				files: {
					'/src/proj1/go.mod': 'module test',
					'/src/proj2/main.go': 'package main'
				},
				expect: ['file:///src/proj1?module', 'file:///src/proj2?workspace']
			},
			'Module in workspace': {
				workspace: ['/src/proj'],
				files: {
					'/src/proj/mod/go.mod': 'module test',
					'/src/proj/main.go': 'package main'
				},
				expect: ['file:///src/proj/mod?module', 'file:///src/proj?workspace']
			}
		},
		Module: {
			'Empty': {
				workspace: ['/src/proj'],
				files: {
					'/src/proj/go.mod': 'module test',
					'/src/proj/main.go': 'package main'
				},
				item: [['test', '/src/proj', 'module']],
				expect: []
			},
			'Root package': {
				workspace: ['/src/proj'],
				files: {
					'/src/proj/go.mod': 'module test',
					'/src/proj/main_test.go': 'package main'
				},
				item: [['test', '/src/proj', 'module']],
				expect: ['file:///src/proj/main_test.go?file'],
				expectPartial: ['file:///src/proj/main_test.go?file']
			},
			'Sub packages': {
				workspace: ['/src/proj'],
				files: {
					'/src/proj/go.mod': 'module test',
					'/src/proj/foo/main_test.go': 'package main',
					'/src/proj/bar/main_test.go': 'package main'
				},
				item: [['test', '/src/proj', 'module']],
				expect: ['file:///src/proj/foo?package', 'file:///src/proj/bar?package']
			},
			'Nested packages': {
				workspace: ['/src/proj'],
				files: {
					'/src/proj/go.mod': 'module test',
					'/src/proj/main_test.go': 'package main',
					'/src/proj/foo/main_test.go': 'package main',
					'/src/proj/foo/bar/main_test.go': 'package main'
				},
				item: [['test', '/src/proj', 'module']],
				expect: [
					'file:///src/proj/foo?package',
					'file:///src/proj/foo/bar?package',
					'file:///src/proj/main_test.go?file'
				],
				expectPartial: ['file:///src/proj/main_test.go?file']
			}
		},
		Package: {
			'Empty': {
				workspace: ['/src/proj'],
				files: {
					'/src/proj/go.mod': 'module test',
					'/src/proj/pkg/main.go': 'package main'
				},
				item: [
					['test', '/src/proj', 'module'],
					['pkg', '/src/proj/pkg', 'package']
				],
				expect: []
			},
			'Flat': {
				workspace: ['/src/proj'],
				files: {
					'/src/proj/go.mod': 'module test',
					'/src/proj/pkg/main_test.go': 'package main',
					'/src/proj/pkg/sub/main_test.go': 'package main'
				},
				item: [
					['test', '/src/proj', 'module'],
					['pkg', '/src/proj/pkg', 'package']
				],
				expect: ['file:///src/proj/pkg/main_test.go?file']
			},
			'Sub package': {
				workspace: ['/src/proj'],
				files: {
					'/src/proj/go.mod': 'module test',
					'/src/proj/pkg/sub/main_test.go': 'package main'
				},
				item: [
					['test', '/src/proj', 'module'],
					['pkg', '/src/proj/pkg', 'package']
				],
				expect: []
			}
		},
		File: {
			'Empty': {
				workspace: ['/src/proj'],
				files: {
					'/src/proj/go.mod': 'module test',
					'/src/proj/main_test.go': 'package main'
				},
				item: [
					['test', '/src/proj', 'module'],
					['main_test.go', '/src/proj/main_test.go', 'file']
				],
				expect: []
			},
			'One of each': {
				workspace: ['/src/proj'],
				files: {
					'/src/proj/go.mod': 'module test',
					'/src/proj/main_test.go': `
						package main

						func TestMain(*testing.M) {}
						func TestFoo(*testing.T) {}
						func BenchmarkBar(*testing.B) {}
						func ExampleBaz() {}
						func FuzzFuss(*testing.F) {}
					`
				},
				item: [
					['test', '/src/proj', 'module'],
					['main_test.go', '/src/proj/main_test.go', 'file']
				],
				expect: [
					'file:///src/proj/main_test.go?test#TestFoo',
					'file:///src/proj/main_test.go?benchmark#BenchmarkBar',
					'file:///src/proj/main_test.go?example#ExampleBaz',
					'file:///src/proj/main_test.go?fuzz#FuzzFuss'
				]
			}
		}
	};

	for (const n in cases) {
		suite(n, () => {
			for (const m in cases[n]) {
				for (const indexEntireWorkspace of [true, false]) {
					const name = indexEntireWorkspace ? m + ' (entire workspace)' : m + ' (limited to package)';
					test(name, async () => {
						const {
							workspace,
							files,
							expect,
							expectPartial: expectPartialData = [],
							item: itemData = []
						} = cases[n][m];
						await vscode.workspace
							.getConfiguration()
							.update(
								'go.testExplorer.indexEntireWorkspace',
								indexEntireWorkspace,
								vscode.ConfigurationTarget.Global
							);
						const { ctrl, resolver } = setup(workspace, files);

						let item: TestItem | undefined;
						for (const [label, uri, kind, name] of itemData) {
							const u = Uri.parse(uri);
							const child = ctrl.createTestItem(GoTest.id(u, kind, name), label, u);
							(item?.children || resolver.items).add(child);
							item = child;
						}
						await resolver.resolve(item);

						const actual: string[] = [];
						(item?.children || resolver.items).forEach((x) => actual.push(x.id));
						if (!indexEntireWorkspace && (n === 'Module' || n === 'Root'))
							assert.deepStrictEqual(actual, expectPartialData);
						else assert.deepStrictEqual(actual, expect);
					});
				}
			}
		});
	}
});

suite('Testify Suite Refresh', () => {
	interface TC extends TestCase {
		item?: ([string, string, GoTestKind] | [string, string, GoTestKind, string])[];
		expect: string[];
		updatedFiles?: Record<string, string>;
		expectAdded?: string[];
		expectRemoved?: string[];
	}

	const cases: Record<string, Record<string, TC>> = {
		File: {
			'Replaced Test Case': {
				workspace: ['/src/proj'],
				files: {
					'/src/proj/main_test.go': `
						package main

						import "github.com/stretchr/testify/suite"

						type SampleTestSuite struct {
							suite.Suite
						}

						func TestSampleTestSuite(t *testing.T) {
							suite.Run(t, new(SampleTestSuite))
						}

						func (s *SampleTestSuite) TestSample1() {}
						func (s *SampleTestSuite) TestSample2() {}
						func (s *SampleTestSuite) TestSample3() {}
					`,
					'/src/proj/another_test.go': `
						package main

						import "github.com/stretchr/testify/suite"

						func (s *SampleTestSuite) TestSample4() {}
						func (s *SampleTestSuite) TestSample5() {}
					`
				},
				item: [
					['main_test.go', '/src/proj/main_test.go', 'file'],
					['another_test.go', '/src/proj/another_test.go', 'file']
				],
				expect: [
					'file:///src/proj/main_test.go?file',
					'file:///src/proj/another_test.go?file',
					'file:///src/proj?package',
					'file:///src/proj/main_test.go?test#TestSampleTestSuite',
					'file:///src/proj/main_test.go?test#%28%2ASampleTestSuite%29.TestSample1',
					'file:///src/proj/main_test.go?test#%28%2ASampleTestSuite%29.TestSample2',
					'file:///src/proj/main_test.go?test#%28%2ASampleTestSuite%29.TestSample3',
					'file:///src/proj/another_test.go?test#%28%2ASampleTestSuite%29.TestSample4',
					'file:///src/proj/another_test.go?test#%28%2ASampleTestSuite%29.TestSample5'
				],
				updatedFiles: {
					'/src/proj/main_test.go': `
					package main

					import "github.com/stretchr/testify/suite"

					type SampleTestSuite struct {
						suite.Suite
					}

					func TestSampleTestSuite(t *testing.T) {
						suite.Run(t, new(SampleTestSuite))
					}

					func (s *SampleTestSuite) TestSample1() {}
					func (s *SampleTestSuite) TestSample2() {}
					func (s *SampleTestSuite) TestSample3() {}
				`,
					'/src/proj/another_test.go': `
						package main

						import "github.com/stretchr/testify/suite"

						func (s *SampleTestSuite) TestSample6() {}
						func (s *SampleTestSuite) TestSample5() {}
					`
				},
				expectAdded: ['file:///src/proj/another_test.go?test#%28%2ASampleTestSuite%29.TestSample6'],
				expectRemoved: ['file:///src/proj/another_test.go?test#%28%2ASampleTestSuite%29.TestSample4']
			},
			'Removed Test Case': {
				workspace: ['/src/proj'],
				files: {
					'/src/proj/main_test.go': `
						package main

						import "github.com/stretchr/testify/suite"

						type SampleTestSuite struct {
							suite.Suite
						}

						func TestSampleTestSuite(t *testing.T) {
							suite.Run(t, new(SampleTestSuite))
						}

						func (s *SampleTestSuite) TestSample1() {}
						func (s *SampleTestSuite) TestSample2() {}
						func (s *SampleTestSuite) TestSample3() {}
					`,
					'/src/proj/another_test.go': `
						package main

						import "github.com/stretchr/testify/suite"

						func (s *SampleTestSuite) TestSample4() {}
						func (s *SampleTestSuite) TestSample5() {}
					`
				},
				item: [
					['main_test.go', '/src/proj/main_test.go', 'file'],
					['another_test.go', '/src/proj/another_test.go', 'file']
				],
				expect: [
					'file:///src/proj/main_test.go?file',
					'file:///src/proj/another_test.go?file',
					'file:///src/proj?package',
					'file:///src/proj/main_test.go?test#TestSampleTestSuite',
					'file:///src/proj/main_test.go?test#%28%2ASampleTestSuite%29.TestSample1',
					'file:///src/proj/main_test.go?test#%28%2ASampleTestSuite%29.TestSample2',
					'file:///src/proj/main_test.go?test#%28%2ASampleTestSuite%29.TestSample3',
					'file:///src/proj/another_test.go?test#%28%2ASampleTestSuite%29.TestSample4',
					'file:///src/proj/another_test.go?test#%28%2ASampleTestSuite%29.TestSample5'
				],
				updatedFiles: {
					'/src/proj/main_test.go': `
					package main

					import "github.com/stretchr/testify/suite"

					type SampleTestSuite struct {
						suite.Suite
					}

					func TestSampleTestSuite(t *testing.T) {
						suite.Run(t, new(SampleTestSuite))
					}

					func (s *SampleTestSuite) TestSample1() {}
					func (s *SampleTestSuite) TestSample2() {}
					func (s *SampleTestSuite) TestSample3() {}
				`,
					'/src/proj/another_test.go': `
					package main

					import "github.com/stretchr/testify/suite"

					func (s *SampleTestSuite) TestSample4() {}
				`
				},
				expectRemoved: ['file:///src/proj/another_test.go?test#%28%2ASampleTestSuite%29.TestSample5']
			}
		}
	};

	for (const n in cases) {
		suite(n, () => {
			for (const m in cases[n]) {
				test(m, async () => {
					const {
						workspace,
						files,
						expect,
						item: itemData = [],
						updatedFiles,
						expectAdded,
						expectRemoved
					} = cases[n][m];
					const { ctrl, resolver } = setup(workspace, files);

					let item: TestItem | undefined;
					const rootTestItems: TestItem[] = [];
					for (const [label, uri, kind, name] of itemData) {
						const u = Uri.parse(uri);
						const child = ctrl.createTestItem(GoTest.id(u, kind, name), label, u);
						(item?.children || resolver.items).add(child);
						rootTestItems.push(child);
					}

					for (item of rootTestItems) {
						await resolver.resolve(item);
					}

					const initialResultEntries: Set<string> = new Set();
					resolver.items.forEach((x) => collectItemId(x, initialResultEntries));

					for (const expectedItem of expect) {
						assert.ok(initialResultEntries.has(expectedItem));
					}

					if (updatedFiles) {
						// force update the document text in the mock.
						const updatedWorkspace = MockTestWorkspace.from(workspace, updatedFiles);
						// eslint-disable-next-line @typescript-eslint/no-explicit-any
						(resolver as any).workspace = updatedWorkspace;

						for (item of rootTestItems) {
							await resolver.resolve(item);
						}
						const updatedResultEntries: Set<string> = new Set();
						resolver.items.forEach((x) => collectItemId(x, updatedResultEntries));
						for (const expectedItem of expectAdded || []) {
							assert.ok(updatedResultEntries.has(expectedItem));
						}
						for (const expectedItem of expectRemoved || []) {
							assert.ok(!updatedResultEntries.has(expectedItem));
						}
					}
				});
			}
		});
	}
});

const collectItemId = (item: TestItem, actual: Set<string>) => {
	actual.add(item.id);
	item.children.forEach((x) => {
		collectItemId(x, actual);
	});
};
