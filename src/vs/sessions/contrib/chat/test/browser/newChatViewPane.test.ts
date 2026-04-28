/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { getNewSessionHeaderLabel, shouldShowWorkspaceAsSecondaryHeader } from '../../browser/newChatViewPane.js';

suite('Sessions - NewChatViewPane', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('prefers the active work-item title for the center new-session header', () => {
		assert.strictEqual(getNewSessionHeaderLabel('Rearchitect Scenarios', true), 'Rearchitect Scenarios');
	});

	test('keeps the active work-item title even before a workspace is selected', () => {
		assert.strictEqual(getNewSessionHeaderLabel('Benchmark analysis', false), 'Benchmark analysis');
	});

	test('falls back to the workspace header when no work item is active', () => {
		assert.strictEqual(getNewSessionHeaderLabel(undefined, true), 'New session in');
	});

	test('falls back to the workspace prompt when nothing is selected', () => {
		assert.strictEqual(getNewSessionHeaderLabel(undefined, false), 'Start by picking a');
	});

	test('shows the workspace picker as secondary metadata when a work item title is present', () => {
		assert.strictEqual(shouldShowWorkspaceAsSecondaryHeader('Rearchitect Scenarios', true), true);
		assert.strictEqual(shouldShowWorkspaceAsSecondaryHeader(undefined, true), false);
		assert.strictEqual(shouldShowWorkspaceAsSecondaryHeader('Rearchitect Scenarios', false), false);
	});
});
